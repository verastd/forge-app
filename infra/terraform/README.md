# Upland data — GCS infrastructure

Terraform for the storage behind the Upland data app (`upland_data` flag).

| Resource | Purpose |
| --- | --- |
| `upland-data-raw` | `actions/YYYY/MM/DD/*.jsonl` — raw chain actions by date (moves to NEARLINE after 90 days) |
| `upland-data-processed` | `properties/*.parquet`, `daily_stats/*.json` |
| `upland-data-checkpoints` | `scraper_state.json` resume points (versioned) |
| `upland-data-sync` service account | `roles/storage.objectAdmin` on those three buckets only |

Buckets are private (uniform access, public access prevention enforced).

## Requirements

- Terraform >= 1.5, `hashicorp/google` provider >= 5.0
- Credentials that can create buckets and service accounts and set bucket IAM
  (`gcloud auth application-default login`, or `GOOGLE_APPLICATION_CREDENTIALS`)

## Apply

```sh
cd infra/terraform
terraform init
terraform plan  -var project_id=<your-project>
terraform apply -var project_id=<your-project>
```

Bucket names are globally unique. If a default is taken, pass
`-var raw_bucket_name=...` (and the processed/checkpoint equivalents), then set the same
names on the API — `terraform output api_env` prints them.

## Point the API at it

The API only uses GCS when it is configured; otherwise it stays on local SQLite.

1. Create a key for the service account, or use workload identity where the API runs:
   `gcloud iam service-accounts keys create key.json --iam-account $(terraform output -raw service_account_email)`
2. Set `GOOGLE_APPLICATION_CREDENTIALS` to the key file, plus the `UPLAND_*_BUCKET` values from
   `terraform output api_env` if you changed any names. Do not commit the key.
3. `POST /api/upland/gcs/sync` uploads the local database; `GET /api/upland/gcs/status` reports it.

## Variables

See `variables.tf`. Only `project_id` is required. `force_destroy` defaults to `false`, so
`terraform destroy` refuses to delete buckets that still hold data.

State is local by default. For shared use, add a `backend "gcs"` block to `versions.tf`.
