"""Google Jules: start a Jules session on the contributor's fork, with their API key.

Coded against, read 2026-10-01:
- https://jules.google/docs/api/reference/ (Overview, Authentication, Sessions, Sources)
- https://jules.googleapis.com/$discovery/rest?version=v1alpha (discovery revision 20260929)

Calls (base https://jules.googleapis.com/v1alpha, header `x-goog-api-key`):
- GET  /sources?pageSize=100[&pageToken=...] -> {sources: [{name, id, githubRepo: {owner,
  repo}}], nextPageToken}. Sources are read-only: the contributor connects the repository
  in the Jules web app first.
- POST /sessions {prompt, title, sourceContext: {source, githubRepoContext:
  {startingBranch}, workingBranch}, automationMode: "AUTO_CREATE_PR",
  requirePlanApproval: false} -> Session {name: "sessions/<id>", id, url, state}
- POST /{sessions/<id>}:sendMessage {prompt} -> {} (follow-up on a running session)
Errors: {"error": {"code", "message", "status"}}; 401 bad or missing key, 403 not
allowed, 404 no such resource. Google APIs answer a malformed key with a 400 whose text
says "API key not valid", which counts as a rejected key here too.

Not proven live (docs/live-tests.md, test 3):
- The source name format: the quickstart shows `sources/github/<owner>/<repo>`, the
  reference pages `sources/github-<owner>-<repo>`. FORGE matches on `githubRepo.owner`
  and `githubRepo.repo` and sends whatever `name` Jules listed.
- That `workingBranch` is honoured on a fork, and where AUTO_CREATE_PR opens the pull
  request (in the fork, or against verastd/forge-app).
- That a 403 on session creation, after the key just listed sources, means the
  repository can't be used rather than a bad key.
"""

from typing import Any

from forge_api.services.rail_adapters.base import (
    AdapterError,
    AdapterRequest,
    AdapterResult,
    CheckResult,
    OutboundCall,
    RailAdapter,
    RailCredential,
    VendorResponse,
    https_url,
    json_body,
    session_ref,
    started_body,
)

BASE_URL = "https://jules.googleapis.com/v1alpha"
SESSION_PAGE = "https://jules.google.com/session/"
KEY_HEADER = "x-goog-api-key"
#: Sources are listed 100 at a time; give up after this many pages.
MAX_SOURCE_PAGES = 5
STARTING_BRANCH = "main"


def _headers(credential: RailCredential) -> dict[str, str]:
    return {
        KEY_HEADER: credential.key,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _bad_key(response: VendorResponse, text: str) -> bool:
    return "api key not valid" in text or "api_key_invalid" in text or "api key expired" in text


def _connect_sentence(fork: str) -> str:
    return (
        f"Jules can't use your copy yet. Sign in at jules.google.com, connect GitHub, "
        f"and give the Jules app access to {fork}. Then try again."
    )


def _matches(source: Any, fork: str) -> bool:
    """Whether a Jules source is `fork` (`owner/name`: the contributor's copy, or
    `<login>/forge-app`)."""
    if not isinstance(source, dict):
        return False
    login, _, fork_name = fork.partition("/")
    repo = source.get("githubRepo")
    if isinstance(repo, dict):
        owner, name = repo.get("owner"), repo.get("repo")
        return (
            isinstance(owner, str)
            and isinstance(name, str)
            and owner.lower() == login.lower()
            and name.lower() == fork_name.lower()
        )
    name = source.get("name")
    candidates = {
        f"sources/github/{login}/{fork_name}".lower(),
        f"sources/github-{login}-{fork_name}".lower(),
    }
    return isinstance(name, str) and name.lower() in candidates


class JulesAdapter(RailAdapter):
    rail = "jules"
    vendor = "Jules"
    supports_notes = True

    def _sources_call(self, credential: RailCredential, page_token: str | None) -> OutboundCall:
        params = {"pageSize": "100"}
        if page_token:
            params["pageToken"] = page_token
        return OutboundCall(
            method="GET",
            url=f"{BASE_URL}/sources",
            headers=_headers(credential),
            params=params,
            secret_headers=frozenset({KEY_HEADER}),
            purpose="List the Jules sources this key can see, to find the fork.",
        )

    def _session_call(self, request: AdapterRequest, source: str) -> OutboundCall:
        return OutboundCall(
            method="POST",
            url=f"{BASE_URL}/sessions",
            headers=_headers(request.credential),
            body={
                "prompt": request.brief,
                "title": request.session_title,
                "sourceContext": {
                    "source": source,
                    "githubRepoContext": {"startingBranch": STARTING_BRANCH},
                    "workingBranch": request.branch,
                },
                "automationMode": "AUTO_CREATE_PR",
                "requirePlanApproval": False,
            },
            secret_headers=frozenset({KEY_HEADER}),
            purpose="Start the Jules session.",
        )

    def plan(self, request: AdapterRequest) -> list[OutboundCall]:
        placeholder = f"<the name Jules lists for {request.fork}>"
        return [
            self._sources_call(request.credential, None),
            self._session_call(request, placeholder),
        ]

    def find_source(self, request: AdapterRequest) -> str:
        """The `name` of the Jules source for the contributor's fork, or
        `rail_setup_needed` when Jules can't see it."""
        token: str | None = None
        for _ in range(MAX_SOURCE_PAGES):
            response = self.call(
                self._sources_call(request.credential, token),
                request.credential,
                rejected=_bad_key,
            )
            body = json_body(response, vendor=self.vendor)
            sources = body.get("sources")
            for source in sources if isinstance(sources, list) else []:
                if _matches(source, request.fork) and isinstance(source.get("name"), str):
                    name: str = source["name"]
                    return name
            next_token = body.get("nextPageToken")
            if not isinstance(next_token, str) or not next_token:
                break
            token = next_token
        raise AdapterError("rail_setup_needed", 404, _connect_sentence(request.fork))

    def start(self, request: AdapterRequest) -> AdapterResult:
        source = self.find_source(request)

        def setup_needed(response: VendorResponse, text: str) -> str | None:
            if response.status in (403, 404) or (
                response.status in (400, 412)
                and any(word in text for word in ("source", "repo", "github", "precondition"))
            ):
                return _connect_sentence(request.fork)
            return None

        response = self.call(
            self._session_call(request, source),
            request.credential,
            setup_needed=setup_needed,
            rejected_statuses=frozenset({401}),
            rejected=_bad_key,
        )
        body = started_body(response)
        name = body.get("name")
        ident = body.get("id")
        ref = session_ref(name) if isinstance(name, str) and name.startswith("sessions/") else None
        if ref is None and session_ref(ident) is not None:
            ref = f"sessions/{ident}"
        url = https_url(body.get("url"), host_suffixes=("jules.google.com", "jules.google"))
        if url is None and ref is not None:
            url = SESSION_PAGE + ref.removeprefix("sessions/")
        return AdapterResult(session_url=url, session_ref=ref)

    def check(self, request: AdapterRequest) -> CheckResult:
        source = self.find_source(request)
        return CheckResult(
            ok=True,
            summary=f"Jules accepted the key and can see {request.fork} as {source}.",
        )

    def send_notes(self, credential: RailCredential, ref: str, text: str) -> None:
        if session_ref(ref) is None or not ref.startswith("sessions/"):
            raise AdapterError("rail_failed", 400, "FORGE has no Jules session to write to.")
        self.call(
            OutboundCall(
                method="POST",
                url=f"{BASE_URL}/{ref}:sendMessage",
                headers=_headers(credential),
                body={"prompt": text},
                secret_headers=frozenset({KEY_HEADER}),
                purpose="Send the check notes to the running Jules session.",
            ),
            credential,
            rejected=_bad_key,
        )
