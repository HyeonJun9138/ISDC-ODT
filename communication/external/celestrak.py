"""CelesTrak HTTP transport only. Caching and fallback belong to Data."""
import httpx


class CelesTrakSource:
    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None):
        self.transport = transport

    async def fetch_gp(self, group: str) -> list[dict]:
        async with httpx.AsyncClient(timeout=12, follow_redirects=True,
                                     headers={'User-Agent': 'SpaceTwin-VVP/0.2'},
                                     transport=self.transport) as client:
            response = await client.get('https://celestrak.org/NORAD/elements/gp.php',
                                        params={'GROUP': group, 'FORMAT': 'JSON'})
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list) or not payload:
                raise ValueError('CelesTrak 응답이 비어 있습니다.')
            return payload

    async def fetch_satcat(self, catalog_number: int) -> dict:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True,
                                     headers={'User-Agent': 'SpaceTwin-VVP/0.3'},
                                     transport=self.transport) as client:
            response = await client.get('https://celestrak.org/satcat/records.php',
                                        params={'CATNR': catalog_number, 'FORMAT': 'JSON'})
            response.raise_for_status()
            records = response.json()
            if not isinstance(records, list) or not records:
                raise ValueError(f'NORAD {catalog_number}의 SATCAT 레코드가 없습니다.')
            if not isinstance(records[0], dict):
                raise ValueError('SATCAT 응답 형식이 올바르지 않습니다.')
            return records[0]
