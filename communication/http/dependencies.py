from starlette.requests import HTTPConnection

from digital_twin.contracts.data_fabric import DataFabricLink
from digital_twin.contracts.data_management import DataManagementLink
from digital_twin.contracts.orchestration import OrchestrationLink
from digital_twin.contracts.runtime import RuntimePort
from digital_twin.contracts.queries import TwinQueries
from data.catalog.contracts import CatalogReader


def runtime_of(connection: HTTPConnection) -> RuntimePort:
    return connection.app.state.runtime


def queries_of(connection: HTTPConnection) -> TwinQueries:
    return connection.app.state.queries


def catalog_of(connection: HTTPConnection) -> CatalogReader:
    return connection.app.state.catalog


def data_fabric_of(connection: HTTPConnection) -> DataFabricLink:
    return connection.app.state.data_fabric


def data_management_of(connection: HTTPConnection) -> DataManagementLink:
    return connection.app.state.data_management


def orchestration_of(connection: HTTPConnection) -> OrchestrationLink:
    return connection.app.state.orchestration
