"""Composition root: owns application instances, lifespan and web deployment."""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from communication.external.celestrak import CelesTrakSource
from communication.http import system, catalog, runtime, rf_network, missions, hil, reports, telemetry
from data.catalog.access import Catalog
from data.catalog.cache import CatalogCache
from data.catalog.contracts import CatalogReader
from digital_twin.contracts.queries import TwinQueries
from digital_twin.model_library.network import communication
from digital_twin.simulation.rf_network import calculate_link_budget, calculate_route, contact_plan
from digital_twin.verification.kpis import evaluate
from user_application.bootstrap import create_runtime
from user_application.configs.paths import APP_NAME, APP_VERSION, WEB_DIR, VISUALIZATION_DIR, CLIENT_DIR, CATALOG_CACHE_DIR


def create_app(*, catalog_reader: CatalogReader | None = None) -> FastAPI:
    state = create_runtime()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await state.start()
        try:
            yield
        finally:
            await state.shutdown()

    app = FastAPI(title=APP_NAME, version=APP_VERSION, lifespan=lifespan)
    app.state.runtime = state
    app.state.catalog = catalog_reader if catalog_reader is not None else Catalog(CelesTrakSource(), CatalogCache(CATALOG_CACHE_DIR))
    app.state.queries = TwinQueries(communication, calculate_link_budget, calculate_route, contact_plan, evaluate)
    app.add_middleware(GZipMiddleware, minimum_size=1_000, compresslevel=5)

    @app.exception_handler(ValueError)
    async def value_error_handler(_, exc: ValueError):
        return JSONResponse(status_code=400, content={'detail': str(exc)})

    for module in (system, catalog, runtime, rf_network, missions, hil, reports, telemetry):
        app.include_router(module.router)

    # Only browser assets are published, never Python modules, workspace or reference files.
    for url, path in (
        ('/static/styles', WEB_DIR / 'styles'),
        ('/static/scripts', WEB_DIR / 'scripts'),
        ('/static/assets', WEB_DIR / 'assets'),
        ('/static/visualization', VISUALIZATION_DIR),
        ('/static/simulation', VISUALIZATION_DIR.parent / 'simulation' / 'browser'),
        ('/static/communication', CLIENT_DIR),
    ):
        app.mount(url, StaticFiles(directory=path), name=url.rsplit('/', 1)[-1])

    @app.get('/favicon.ico', include_in_schema=False)
    async def favicon():
        return Response(status_code=204)

    @app.get('/{full_path:path}', include_in_schema=False)
    async def frontend(full_path: str):
        return FileResponse(WEB_DIR / 'index.html')

    return app
