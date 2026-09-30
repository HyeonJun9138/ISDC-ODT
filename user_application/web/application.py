"""Composition root: owns application instances, lifespan and web deployment."""
import mimetypes
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from communication.external.celestrak import CelesTrakSource
from communication.external.data_fabric import RemoteDataFabric
from communication.external.data_management import RemoteDataManagement
from communication.external.orchestration import RemoteOrchestration
from communication.external.security import RemoteSecurity
from communication.http import system, catalog, runtime, rf_network, missions, hil, reports, telemetry, integration, scenarios as scenarios_http
from communication.http import data_fabric as data_fabric_http
from communication.http import data_management as data_management_http
from communication.http import orchestration as orchestration_http
from communication.http import security as security_http
from data.catalog.access import Catalog
from data.catalog.cache import CatalogCache
from data.catalog.contracts import CatalogReader
from digital_twin.contracts.data_fabric import DataFabricLink
from digital_twin.contracts.data_management import DataManagementLink
from digital_twin.contracts.orchestration import OrchestrationLink
from digital_twin.contracts.security import SecurityLink
from digital_twin.contracts.queries import TwinQueries
from digital_twin.model_library.network import communication
from digital_twin.simulation.rf_network import calculate_link_budget, calculate_route, contact_plan
from digital_twin.verification.kpis import evaluate
from operations_software.data_fabric import DataFabricStandIn
from operations_software.data_management import ScopedDataManagement
from operations_software.orchestration import OrchestrationStandIn
from operations_software.security import SecurityStandIn
from user_application.bootstrap import create_runtime
from user_application.configs.paths import APP_NAME, APP_VERSION, WEB_DIR, VISUALIZATION_DIR, CLIENT_DIR, CATALOG_CACHE_DIR
from user_application.configs.security import AUTHENTICATION_THRESHOLD, SECURITY_URL_ENV
from user_application.configs.scenarios import scenario_library

# Python's registry has no entry for glTF binaries; browsers need it to stream the NASA models.
mimetypes.add_type("model/gltf-binary", ".glb")

# The data fabric (데이터 송수신 기술) is partner software. It runs embedded as a stand-in unless an
# external module address is given by the caller or by SPACETWIN_DATA_FABRIC_URL (set by the CLI).
DATA_FABRIC_URL_ENV = "SPACETWIN_DATA_FABRIC_URL"
# The data management module (데이터 관리, ICD-01) follows the same rule with SPACETWIN_DATA_MANAGEMENT_URL.
DATA_MANAGEMENT_URL_ENV = "SPACETWIN_DATA_MANAGEMENT_URL"
# The constellation operations module (군집 운용, ICD-03) follows the same rule with SPACETWIN_ORCHESTRATION_URL.
ORCHESTRATION_URL_ENV = "SPACETWIN_ORCHESTRATION_URL"


def default_data_fabric() -> DataFabricLink:
    url = os.environ.get(DATA_FABRIC_URL_ENV, "").strip()
    return RemoteDataFabric(url) if url else DataFabricStandIn()


def default_data_management() -> DataManagementLink:
    url = os.environ.get(DATA_MANAGEMENT_URL_ENV, "").strip()
    return RemoteDataManagement(url) if url else ScopedDataManagement()


def default_orchestration() -> OrchestrationLink:
    url = os.environ.get(ORCHESTRATION_URL_ENV, "").strip()
    return RemoteOrchestration(url) if url else OrchestrationStandIn()


def default_security() -> SecurityLink:
    url = os.environ.get(SECURITY_URL_ENV, "").strip()
    return RemoteSecurity(url) if url else SecurityStandIn(authentication_threshold=AUTHENTICATION_THRESHOLD)


def create_app(*, catalog_reader: CatalogReader | None = None, data_fabric: DataFabricLink | None = None,
               data_management: DataManagementLink | None = None, security: SecurityLink | None = None,
               orchestration: OrchestrationLink | None = None) -> FastAPI:
    state = create_runtime()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await state.start()
        try:
            yield
        finally:
            try:
                await state.shutdown()
            finally:
                close_security = getattr(app.state.security, "close", None)
                if close_security is not None:
                    close_security()

    app = FastAPI(title=APP_NAME, version=APP_VERSION, lifespan=lifespan)
    app.state.runtime = state
    app.state.catalog = catalog_reader if catalog_reader is not None else Catalog(CelesTrakSource(), CatalogCache(CATALOG_CACHE_DIR))
    app.state.queries = TwinQueries(communication, calculate_link_budget, calculate_route, contact_plan, evaluate)
    app.state.data_fabric = data_fabric if data_fabric is not None else default_data_fabric()
    app.state.data_management = data_management if data_management is not None else default_data_management()
    app.state.data_management_bridge = data_management_http.DataManagementBridge()
    app.state.security = security if security is not None else default_security()
    app.state.orchestration = orchestration if orchestration is not None else default_orchestration()
    app.state.security_bridge = security_http.SecurityBridge()
    app.add_middleware(GZipMiddleware, minimum_size=1_000, compresslevel=5)

    @app.exception_handler(ValueError)
    async def value_error_handler(_, exc: ValueError):
        return JSONResponse(status_code=400, content={'detail': str(exc)})

    # Browser modules are imported by relative paths that carry no version query, and the HTML shell
    # carries the version queries of everything else, so a browser must revalidate both (ETag → 304)
    # instead of trusting heuristic freshness after a code update.
    @app.middleware('http')
    async def revalidate_static(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith('/static/') or response.headers.get('content-type', '').startswith('text/html'):
            response.headers['Cache-Control'] = 'no-cache'
        return response

    # PoC scenario definitions are operational configuration; the console reads them through /api/scenarios.
    app.state.scenario_library = scenario_library()
    for module in (system, catalog, runtime, rf_network, missions, hil, reports, telemetry, data_fabric_http, data_management_http, security_http, orchestration_http, integration, scenarios_http):
        app.include_router(module.router)

    # Only browser assets are published, never Python modules, workspace or reference files.
    for url, path in (
        ('/static/styles', WEB_DIR / 'styles'),
        ('/static/scripts', WEB_DIR / 'scripts'),
        ('/static/assets', WEB_DIR / 'assets'),
        ('/static/visualization', VISUALIZATION_DIR),
        ('/static/simulation', VISUALIZATION_DIR.parent / 'simulation' / 'browser'),
        ('/static/model_library', VISUALIZATION_DIR.parent / 'model_library' / 'browser'),
        ('/static/communication', CLIENT_DIR),
        ('/static/verification', VISUALIZATION_DIR.parent / 'verification' / 'browser'),
    ):
        app.mount(url, StaticFiles(directory=path), name=url.rsplit('/', 1)[-1])

    @app.get('/favicon.ico', include_in_schema=False)
    async def favicon():
        return Response(status_code=204)

    @app.get('/{full_path:path}', include_in_schema=False)
    async def frontend(full_path: str):
        if full_path == 'api' or full_path.startswith('api/'):
            return JSONResponse(status_code=404, content={'detail': f'등록되지 않은 API 경로입니다: /{full_path}'})
        return FileResponse(WEB_DIR / 'index.html')

    return app
