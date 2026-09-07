from starlette.requests import HTTPConnection

from digital_twin.contracts.runtime import RuntimePort
from digital_twin.contracts.queries import TwinQueries
from data.catalog.contracts import CatalogReader


def runtime_of(connection: HTTPConnection) -> RuntimePort:
    return connection.app.state.runtime


def queries_of(connection: HTTPConnection) -> TwinQueries:
    return connection.app.state.queries


def catalog_of(connection: HTTPConnection) -> CatalogReader:
    return connection.app.state.catalog
