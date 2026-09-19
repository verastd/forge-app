variable "project_id" {
  description = "GCP project that owns the Upland data buckets and service account."
  type        = string
}

variable "region" {
  description = "Location for the buckets (a region such as us-central1, or a multi-region such as US)."
  type        = string
  default     = "us-central1"
}

# Bucket names are global across all of GCS. The defaults match what the API
# (services/upland/storage.py) uses when UPLAND_*_BUCKET is unset; if a default is
# already taken, override it here AND set the matching UPLAND_*_BUCKET env var.
variable "raw_bucket_name" {
  description = "Raw Hyperion actions as JSONL: actions/YYYY/MM/DD/*.jsonl."
  type        = string
  default     = "upland-data-raw"
}

variable "processed_bucket_name" {
  description = "Processed data: properties/*.parquet and daily_stats/*.json."
  type        = string
  default     = "upland-data-processed"
}

variable "checkpoint_bucket_name" {
  description = "Scraper resume points: scraper_state.json."
  type        = string
  default     = "upland-data-checkpoints"
}

variable "service_account_id" {
  description = "Account id (before the @) of the service account the API uses for GCS."
  type        = string
  default     = "upland-data-sync"
}

variable "raw_nearline_after_days" {
  description = "Move raw action objects to NEARLINE after this many days (0 disables the rule)."
  type        = number
  default     = 90
}

variable "force_destroy" {
  description = "Allow `terraform destroy` to delete non-empty buckets. Leave false outside throwaway environments."
  type        = bool
  default     = false
}

variable "labels" {
  description = "Labels applied to every bucket."
  type        = map(string)
  default = {
    app = "forge-upland-data"
  }
}
