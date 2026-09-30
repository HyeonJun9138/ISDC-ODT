"""CelesTrak HTTP transport only. Caching and fallback belong to Data.

Two things here are about not being blocked rather than about data. A GP request
carries If-Modified-Since once a snapshot is held, which the usage policy asks
for and which answers in a few hundred bytes instead of megabytes when nothing
has changed. And redirects are not followed: a provider that has moved, or a
page standing in front of it, would otherwise turn one request into two and
arrive looking like a normal answer. A person should see that instead.
"""
import httpx


class CelesTrakSource:
    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None):
        self.transport = transport
        # What the provider said about the snapshot just handed over, for the
        # caller to keep and send back next time.
        self.last_modified = ''

    @staticmethod
    def _refuse_redirect(response: httpx.Response) -> None:
        if response.is_redirect:
            raise httpx.HTTPStatusError(
                f"CelesTrak가 {response.headers.get('location', '')}로 주소 변경을 알렸습니다.",
                request=response.request, response=response)

    async def fetch_gp(self, group: str, if_modified_since: str = '') -> list[dict] | None:
        """The group's elements, or None when the provider answers that the
        snapshot the caller already holds is still current."""
        headers = {'User-Agent': 'SpaceTwin-VVP/0.2'}
        known = str(if_modified_since or '')
        if known:
            headers['If-Modified-Since'] = known
        async with httpx.AsyncClient(timeout=12, follow_redirects=False,
                                     headers=headers, transport=self.transport) as client:
            response = await client.get('https://celestrak.org/NORAD/elements/gp.php',
                                        params={'GROUP': group, 'FORMAT': 'JSON'})
            if response.status_code == 304:
                self.last_modified = response.headers.get('Last-Modified', known)
                return None
            self._refuse_redirect(response)
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list) or not payload:
                raise ValueError('CelesTrak 응답이 비어 있습니다.')
            self.last_modified = response.headers.get('Last-Modified', '')
            return payload

    async def fetch_satcat(self, catalog_number: int) -> dict:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False,
                                     headers={'User-Agent': 'SpaceTwin-VVP/0.3'},
                                     transport=self.transport) as client:
            response = await client.get('https://celestrak.org/satcat/records.php',
                                        params={'CATNR': catalog_number, 'FORMAT': 'JSON'})
            self._refuse_redirect(response)
            response.raise_for_status()
            records = response.json()
            if not isinstance(records, list) or not records:
                raise ValueError(f'NORAD {catalog_number}의 SATCAT 레코드가 없습니다.')
            if not isinstance(records[0], dict):
                raise ValueError('SATCAT 응답 형식이 올바르지 않습니다.')
            return records[0]
