output "raw_bucket_url" {
  description = "gs:// URL of the raw actions bucket."
  value       = "gs://${google_storage_bucket.this["raw"].name}"
}

output "processed_bucket_url" {
  description = "gs:// URL of the processed data bucket."
  value       = "gs://${google_storage_bucket.this["processed"].name}"
}

output "checkpoint_bucket_url" {
  description = "gs:// URL of the scraper checkpoint bucket."
  value       = "gs://${google_storage_bucket.this["checkpoints"].name}"
}

output "service_account_email" {
  description = "Service account the API authenticates as."
  value       = google_service_account.sync.email
}

output "api_env" {
  description = "Environment variables to set on forge-api so it targets these buckets."
  value = {
    UPLAND_RAW_BUCKET        = google_storage_bucket.this["raw"].name
    UPLAND_PROCESSED_BUCKET  = google_storage_bucket.this["processed"].name
    UPLAND_CHECKPOINT_BUCKET = google_storage_bucket.this["checkpoints"].name
  }
}
