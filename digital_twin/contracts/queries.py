from dataclasses import dataclass
from typing import Callable

from .state import RuntimeSnapshot


@dataclass(frozen=True)
class TwinQueries:
    """Stateless domain operations supplied to the HTTP adapter by the application."""

    network: Callable[[], dict]
    calculate_link_budget: Callable[[dict], dict]
    calculate_route: Callable[[str, str, str, list[dict]], dict]
    contact_plan: Callable[[int], list[dict]]
    evaluate: Callable[[RuntimeSnapshot], dict]
