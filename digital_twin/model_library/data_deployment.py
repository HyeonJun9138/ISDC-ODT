"""Representative equipment values shared with the SDC node model, not measured storage."""
DTN_STORAGE_GB = 2000.0
TELEMETRY_PROFILE = {"class": "telemetry", "interval_s": 30, "size_mb": [8, 24]}
IMAGERY_PROFILE = {"class": "imagery", "interval_s": 90, "size_mb": [400, 1200]}
OUTAGE_FAULT_KINDS = ("power_drop", "storage_pressure", "thermal_spike", "link_loss")
