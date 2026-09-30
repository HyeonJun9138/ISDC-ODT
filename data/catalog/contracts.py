from typing import Protocol


class CatalogSource(Protocol):
    # if_modified_since is what the provider last said about the caller's
    # snapshot; None comes back when it answers that the snapshot is current.
    async def fetch_gp(self, group: str, if_modified_since: str = '') -> list[dict] | None: ...

    async def fetch_satcat(self, catalog_number: int) -> dict: ...


class CatalogReader(Protocol):
    def catalog_groups(self) -> list[dict]: ...

    async def get_satellites(self, group: str = 'active', limit: int = 0,
                            offset: int = 0, query: str = '', orbit: str = 'all') -> dict: ...

    async def get_satellite_profile(self, catalog_number: int) -> dict: ...
