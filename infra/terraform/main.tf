# GCS storage for the Upland data app (ledger.upland.me).
#
#   gs://<raw>/actions/YYYY/MM/DD/*.jsonl      raw actions by date
#   gs://<processed>/properties/*.parquet      processed property data
#   gs://<processed>/daily_stats/*.json        aggregated daily stats
#   gs://<checkpoints>/scraper_state.json      resume points

locals {
  buckets = {
    raw         = var.raw_bucket_name
    processed   = var.processed_bucket_name
    checkpoints = var.checkpoint_bucket_name
  }
}

resource "google_storage_bucket" "this" {
  for_each = local.buckets

  name          = each.value
  location      = var.region
  storage_class = "STANDARD"
  labels        = merge(var.labels, { role = each.key })
  force_destroy = var.force_destroy

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Checkpoints are tiny and losing one means re-scraping; keep history.
  versioning {
    enabled = each.key == "checkpoints"
  }

  dynamic "lifecycle_rule" {
    for_each = each.key == "raw" && var.raw_nearline_after_days > 0 ? [1] : []
    content {
      condition {
        age = var.raw_nearline_after_days
      }
      action {
        type          = "SetStorageClass"
        storage_class = "NEARLINE"
      }
    }
  }

  # Failed multipart uploads should not linger.
  lifecycle_rule {
    condition {
      age = 7
    }
    action {
      type = "AbortIncompleteMultipartUpload"
    }
  }
}

resource "google_service_account" "sync" {
  account_id   = var.service_account_id
  display_name = "Upland data sync"
  description  = "Used by forge-api to upload scraped Upland data to GCS."
}

# objectAdmin (create/read/overwrite/delete objects) on exactly these buckets, not project-wide.
resource "google_storage_bucket_iam_member" "sync_object_admin" {
  for_each = google_storage_bucket.this

  bucket = each.value.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.sync.email}"
}
