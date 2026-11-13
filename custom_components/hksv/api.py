"""Small authenticated client for the local engine."""
import aiohttp
from yarl import URL

DEFAULT_RESOLUTION = "1080p"


def camera_payload(data, options=None):
    return {
        "id": data["camera_id"],
        "name": data["name"],
        "rtspUrl": data["rtsp_url"],
        "audio": data.get("audio", False),
        "softwareMotion": data.get("software_motion", False),
        "maxResolution": (options or {}).get(
            "max_resolution", data.get("max_resolution", DEFAULT_RESOLUTION)
        ),
    }


class EngineClient:
    def __init__(self, session, url, token):
        parsed = URL(url)
        if parsed.scheme not in ("http", "https") or not parsed.host or parsed.user or parsed.query_string or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("Use the engine's base HTTP URL")
        self.session = session
        self.url = str(parsed).rstrip("/")
        self.token = token

    async def request(self, method, path, data=None):
        async with self.session.request(
            method, self.url + path, json=data,
            headers={"Authorization": "Bearer " + self.token},
            timeout=aiohttp.ClientTimeout(total=10), allow_redirects=False,
        ) as response:
            if response.status != 200:
                raise aiohttp.ClientError("Engine rejected request")
            return await response.json()
