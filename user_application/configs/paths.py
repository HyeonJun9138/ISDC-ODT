from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
WEB_DIR = ROOT_DIR / "user_application" / "web"
VISUALIZATION_DIR = ROOT_DIR / "digital_twin" / "visualization"
CLIENT_DIR = ROOT_DIR / "communication" / "browser"
CATALOG_CACHE_DIR = ROOT_DIR / "data" / "workspace" / "catalog_cache"
APP_NAME = "SpaceTwin VVP"
APP_VERSION = "0.3.0"
DEFAULT_HOST = "103.218.162.73"
