#!/usr/bin/env python3

import os
import sys
import json
import base64
import httpx
import uvicorn
import asyncio
from typing import Union
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi import WebSocket
from asyncio import gather

app = FastAPI(title="HiFi-RestAPI", version="v1.1", description="Tidal Music Proxy (Auto-Region)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Embedder-Policy"] = "credentialless"     
    return response

load_dotenv()

CLIENT_ID = os.getenv("CLIENT_ID", "zU4XHVVkc2tDPo4t")
CLIENT_SECRET = os.getenv("CLIENT_SECRET", "VJKhDFqJPqvsPVNBV6ukXTJmwlvbttP7wlMlrc72se4=")
USER_ID = os.getenv("USER_ID")
TOKEN_FILE = "token.json"

async def refresh():
    if not os.path.exists(TOKEN_FILE):
        raise HTTPException(status_code=401, detail="token.json 不存在，请先生成 token.json")
    
    try:
        with open(TOKEN_FILE, "r") as f:
            token_data = json.load(f)
    except json.JSONDecodeError:
        raise HTTPException(status_code=401, detail="token.json 格式错误")

    access_token = token_data.get("access_token")
    country_code = token_data.get("country_code", "US")

    if not access_token:
        raise HTTPException(status_code=401, detail="token.json 不包含 access_token")
    
    return access_token, country_code

@app.api_route("/module-paged-data/{module_path:path}", methods=["GET"])
async def get_module_paged_data(module_path: str, offset: int = 0, limit: int = 50):
    try:
        print(f"--- 🌀 [BACKEND] 收到分页请求: {module_path}, Offset: {offset} ---")
        tidal_token, region = await refresh()
        headers = {"authorization": f"Bearer {tidal_token}"}
        
        async with httpx.AsyncClient(http2=True) as client:
            real_data_path = None
            if module_path.startswith("pages/data/"):
                real_data_path = module_path
                print(f"--- ✅ [BACKEND] 检测到直接数据路径: {real_data_path} ---")
            else:
                print(f"--- ⚠️ [BACKEND] 检测到旧模块路径, 正在执行两步请求... ---")
                module_url = f"https://api.tidal.com/v1/{module_path}?countryCode={region}&locale=en_US&deviceType=BROWSER"
                module_res = await client.get(module_url, headers=headers)
                module_res.raise_for_status()
                module_data = module_res.json()
                if "rows" in module_data and module_data["rows"] and "modules" in module_data["rows"][0] and module_data["rows"][0]["modules"] and "pagedList" in module_data["rows"][0]["modules"][0]:
                    real_data_path = module_data["rows"][0]["modules"][0]["pagedList"].get("dataApiPath")
            
            if not real_data_path:
                print(f"🔴 [BACKEND] 致命错误: 无法找到 real_data_path (路径: {module_path})")
                raise HTTPException(status_code=404, detail="无法在该模块中找到 dataApiPath")

            paged_url = f"https://api.tidal.com/v1/{real_data_path}?countryCode={region}&locale=en_US&deviceType=BROWSER&offset={offset}&limit={limit}"
            print(f"--- 🚀 [BACKEND] 正在请求Tidal: {paged_url} ---")
            paged_res = await client.get(paged_url, headers=headers)
            paged_res.raise_for_status()
            print("--- 🏁 [BACKEND] Tidal请求成功, 正在返回数据 ---")
            return paged_res.json()
    except httpx.HTTPStatusError as e:
        print(f"🔴🔴🔴 HTTP Error in /module-paged-data: {e.response.status_code} - {e.response.text}")
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)
    except Exception as e:
        print(f"🔴🔴🔴 Generic Error in /module-paged-data: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.api_route("/home", methods=["GET"])
async def get_home():
    try:
        tidal_token, region = await refresh()
        headers = {"authorization": f"Bearer {tidal_token}"}
        home_url = f"https://tidal.com/v1/pages/single-module-page/6d515891-9c40-466b-a371-52cdb3d16fee/3/739de1f7-4768-463e-a6b6-e173a03fb96e/2?countryCode={region}&locale=en_US&deviceType=BROWSER"
        async with httpx.AsyncClient(http2=True) as client:
            res = await client.get(home_url, headers=headers)
            res.raise_for_status()
            return res.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.api_route("/album/{id}/tracks", methods=["GET"])
async def get_album_tracks(id: int, offset: int = 0, limit: int = 100):
    try:
        tidal_token, region = await refresh()
        headers = {"authorization": f"Bearer {tidal_token}"}
        items_url = f"https://api.tidal.com/v1/albums/{id}/items?countryCode={region}&limit={limit}&offset={offset}"
        async with httpx.AsyncClient(http2=True) as client:
            res = await client.get(items_url, headers=headers)
            res.raise_for_status()
            items_data = res.json()
            items = items_data.get('items', [])
            tracks_list = []
            if items:
                if isinstance(items[0], dict) and 'item' in items[0]:
                    tracks_list = [i['item'] for i in items if isinstance(i, dict) and 'item' in i]
                else:
                    tracks_list = items
            return {
                "items": tracks_list,
                "limit": items_data.get("limit"),
                "offset": items_data.get("offset"),
                "totalNumberOfItems": items_data.get("totalNumberOfItems")
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.api_route("/artist", methods=["GET"])
async def get_artist(id: int = None, f: Union[int, None] = Query(default=None)):
    try:
        tidal_token, region = await refresh()
        headers = {"authorization": f"Bearer {tidal_token}"}
        async with httpx.AsyncClient(http2=True) as client:
            if f:
                artist_details_url = f"https://api.tidal.com/v1/artists/{f}?countryCode={region}"
                artist_albums_url = f"https://api.tidal.com/v1/artists/{f}/albums?countryCode={region}&limit=100"
                artist_singles_url = f"https://api.tidal.com/v1/artists/{f}/albums?countryCode={region}&filter=EPSANDSINGLES&limit=100"
                tasks = [
                    client.get(artist_details_url, headers=headers),
                    client.get(artist_albums_url, headers=headers),
                    client.get(artist_singles_url, headers=headers)
                ]
                details_res, albums_res, singles_res = await gather(*tasks)
                details_res.raise_for_status()
                albums_res.raise_for_status()
                singles_res.raise_for_status()
                return {
                    "details": details_res.json(),
                    "albums": albums_res.json().get("items", []),
                    "singles": singles_res.json().get("items", [])
                }
            elif id:
                artist_url = f"https://api.tidal.com/v1/artists/{id}?countryCode={region}"
                res = await client.get(artist_url, headers=headers)
                res.raise_for_status()
                return res.json()
            else:
                raise HTTPException(status_code=400, detail="Either 'id' or 'f' query is required for artist.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.api_route("/dash", methods=["GET"])
async def get_hi_res(id: int, quality: str = "HI_RES_LOSSLESS"):
    try:
        tidal_token, region = await refresh()
        track_url = f"https://tidal.com/v1/tracks/{id}/playbackinfo?audioquality={quality}&playbackmode=STREAM&assetpresentation=FULL"
        headers = {"authorization": f"Bearer {tidal_token}"}
        async with httpx.AsyncClient(http2=True) as client:
            res = await client.get(track_url, headers=headers)
            res.raise_for_status()
            final_data = res.json()
            decode_manifest = base64.b64decode(final_data["manifest"])
            return Response(content=decode_manifest, media_type=final_data["manifestMimeType"])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.api_route("/track", methods=["GET"])
async def get_track(id: int, quality: str = "LOSSLESS"):
    try:
        if quality == "HI_RES_LOSSLESS":
            raise HTTPException(status_code=400, detail="HI_RES_LOSSLESS not supported, use /dash endpoint.") 
        tidal_token, region = await refresh()
        headers = {"authorization": f"Bearer {tidal_token}"}
        track_url = f"https://api.tidal.com/v1/tracks/{id}/playbackinfopostpaywall/v4?audioquality={quality}&playbackmode=STREAM&assetpresentation=FULL"
        info_url = f"https://api.tidal.com/v1/tracks/{id}/?countryCode={region}"
        
        async with httpx.AsyncClient(http2=True) as client:
            track_data_res = await client.get(track_url, headers=headers)
            info_data_res = await client.get(info_url, headers=headers)
            track_data_res.raise_for_status()
            info_data_res.raise_for_status()
            track_data = track_data_res.json()
            info_data = info_data_res.json()
            manifest_b64 = track_data["manifest"]
            manifest_json = base64.b64decode(manifest_b64)
            manifest = json.loads(manifest_json)
            audio_url = manifest.get("urls")[0]
            au_j = {"OriginalTrackUrl": audio_url}
            return JSONResponse(content=[info_data, track_data, au_j])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.api_route("/lyrics", methods=["GET"])
async def get_lyrics(id: int):
    try:
        tidal_token, region = await refresh()
        headers = {"authorization": f"Bearer {tidal_token}"}
        url = f"https://api.tidal.com/v1/tracks/{id}/lyrics?countryCode={region}&locale=en_US&deviceType=BROWSER"
        async with httpx.AsyncClient(http2=True) as client:
            res = await client.get(url, headers=headers)
            res.raise_for_status()
            return JSONResponse(content=[res.json()])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.api_route("/song", methods=["GET"])
async def get_song(q: str, quality: str):
    try:
        tidal_token, region = await refresh()
        headers = {"authorization": f"Bearer {tidal_token}"}
        search_url = f"https://api.tidal.com/v1/search/tracks?countryCode={region}&query={q}"
        async with httpx.AsyncClient(http2=True) as client:
            search_data_res = await client.get(search_url, headers=headers)
            search_data_res.raise_for_status()
            search_data = search_data_res.json()
            if not search_data.get("items"):
                raise HTTPException(status_code=404, detail=f"No track found for query: {q}")
            track_id = search_data["items"][0]["id"]
            track_url = f"https://api.tidal.com/v1/tracks/{track_id}/playbackinfopostpaywall/v4?audioquality={quality}&playbackmode=STREAM&assetpresentation=FULL"
            track_data_res = await client.get(track_url, headers=headers)
            track_data_res.raise_for_status()
            track_data = track_data_res.json()
            manifest_b64 = track_data["manifest"]
            manifest_json = base64.b64decode(manifest_b64)
            manifest = json.loads(manifest_json)
            audio_url = manifest.get("urls")[0]
            au_j = {"OriginalTrackUrl": audio_url}
            return JSONResponse(content=[search_data["items"][0], track_data, au_j])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.api_route("/search", methods=["GET"])
async def search(
    s: Union[str, None] = Query(default=None),
    a: Union[str, None] = Query(default=None),
    al: Union[str, None] = Query(default=None),
    v: Union[str, None] = Query(default=None),
    p: Union[str, None] = Query(default=None),
    limit: int = 25,
    offset: int = 0
):
    try:
        tidal_token, region = await refresh()
        headers = {"authorization": f"Bearer {tidal_token}"}
        async with httpx.AsyncClient(http2=True) as client:
            if s:
                url = f"https://api.tidal.com/v1/search/tracks?query={s}&limit={limit}&offset={offset}&countryCode={region}"
            elif a:
                url = f"https://api.tidal.com/v1/search/top-hits?query={a}&limit={limit}&offset={offset}&types=ARTISTS,TRACKS&countryCode={region}"
            elif al:
                url = f"https://api.tidal.com/v1/search/top-hits?query={al}&limit={limit}&offset={offset}&types=ALBUMS&countryCode={region}"
            elif v:
                url = f"https://api.tidal.com/v1/search/videos?query={v}&limit={limit}&offset={offset}&countryCode={region}"
            elif p:
                url = f"https://api.tidal.com/v1/search/playlists?query={p}&limit={limit}&offset={offset}&countryCode={region}"
            else:
                raise HTTPException(status_code=400, detail="A search query parameter is required.")      
            res = await client.get(url, headers=headers)
            res.raise_for_status()
            return res.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.api_route("/playlist", methods=["GET"])
async def get_playlist(id: str):
    try:
        tidal_token, region = await refresh()
        headers = {"authorization": f"Bearer {tidal_token}"}
        playlist_url = f"https://api.tidal.com/v1/playlists/{id}?countryCode={region}"
        items_url = f"https://api.tidal.com/v1/playlists/{id}/items?countryCode={region}&limit=100"
        async with httpx.AsyncClient(http2=True) as client:
            playlist_data_res = await client.get(playlist_url, headers=headers)
            playlist_items_res = await client.get(items_url, headers=headers)
            playlist_data_res.raise_for_status()
            playlist_items_res.raise_for_status()
            return JSONResponse(content=[playlist_data_res.json(), playlist_items_res.json()])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.api_route("/cover", methods=["GET"])
async def get_cover(id: Union[int, None] = None, q: Union[str, None] = None):
    try:
        tidal_token, region = await refresh()
        headers = {"authorization": f"Bearer {tidal_token}"}
        async with httpx.AsyncClient(http2=True) as client:
            if id:
                track_url = f"https://api.tidal.com/v1/tracks/{id}/?countryCode={region}"
                res = await client.get(track_url, headers=headers)
                res.raise_for_status()
                track = res.json()
                album = track.get("album", {})
                album_cover = album.get("cover", "").replace("-", "/")
                json_data = [{"id": album.get("id"), "name": album.get("title"),
                    "1280": f"https://resources.tidal.com/images/{album_cover}/1280x1280.jpg" if album_cover else None,
                    "640": f"https://resources.tidal.com/images/{album_cover}/640x640.jpg" if album_cover else None,
                    "80": f"https://resources.tidal.com/images/{album_cover}/80x80.jpg" if album_cover else None,
                }]
                return JSONResponse(content=json_data)
            elif q:
                search_url = f"https://api.tidal.com/v1/search/tracks?countryCode={region}&query={q}"
                res = await client.get(search_url, headers=headers)
                res.raise_for_status()
                tracks = res.json().get("items", [])[:10]
                json_data = []
                for track in tracks:
                    album = track.get("album", {})
                    album_cover = album.get("cover", "").replace("-", "/")
                    json_data.append({"id": track.get("id"), "name": track.get("title"),
                        "1280": f"https://resources.tidal.com/images/{album_cover}/1280x1280.jpg" if album_cover else None,
                        "640": f"https://resources.tidal.com/images/{album_cover}/640x640.jpg" if album_cover else None,
                        "80": f"https://resources.tidal.com/images/{album_cover}/80x80.jpg" if album_cover else None,
                    })
                return JSONResponse(content=json_data)
            else:
                raise HTTPException(status_code=400, detail="Either 'id' or 'q' query is required for artist.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.api_route("/item/{item_type}/{item_id}", methods=["GET"])
async def get_item_details(item_type: str, item_id: str):
    if item_type not in ["album", "track"]:
        raise HTTPException(status_code=400, detail="Invalid item type.")
    try:
        tidal_token, region = await refresh()
        headers = {"authorization": f"Bearer {tidal_token}"}
        
        url_map = {
            "album": f"https://api.tidal.com/v1/albums/{item_id}?countryCode={region}",
            "track": f"https://api.tidal.com/v1/tracks/{item_id}?countryCode={region}",
        }
        
        url = url_map[item_type]
        async with httpx.AsyncClient(http2=True) as client:
            res = await client.get(url, headers=headers)
            res.raise_for_status()
            return res.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/get-token-region")
async def get_token_region():
    if not os.path.exists(TOKEN_FILE):
        return {"region": "N/A", "error": "Token file not found"}
    try:
        with open(TOKEN_FILE, "r") as f:
            token_data = json.load(f)
        country_code = token_data.get("country_code")
        return {"region": country_code if country_code else "Unk"}
    except Exception as e:
        return {"region": "Err", "error": str(e)}

@app.websocket("/ws/run-login")
async def websocket_run_login(websocket: WebSocket):
    await websocket.accept()
    script_path = os.path.join(os.path.dirname(__file__), "login.py")
    cmd = f"{sys.executable} -u {script_path}"
    
    process = None
    try:
        process = await asyncio.create_subprocess_shell(
            cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        async def read_stream(stream, stream_name):
            while True:
                line = await stream.readline()
                if line:
                    line_text = line.decode('utf-8', errors='ignore').strip()
                    if line_text:
                        await websocket.send_text(f"{line_text}")
                else:
                    break
                    
        await asyncio.gather(
            read_stream(process.stdout, "stdout"),
            read_stream(process.stderr, "stderr")
        )
        await process.wait()
        await websocket.send_text("\n=== 脚本执行完毕 ===")

    except Exception as e:
        await websocket.send_text(f"❌ 错误: {str(e)}")
    finally:
        await websocket.close()

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse("static/favicon.ico")

@app.get("/", include_in_schema=False)
async def read_index():
    return FileResponse('static/index.html')

app.mount("/", StaticFiles(directory="static"), name="static")

if __name__ == "__main__":
    if not os.path.exists(TOKEN_FILE):
        print("🔴 FATAL: token.json 不存在，请先生成 token.json")
    else:
        print("✅ token.json 已加载，启动服务器...")
        uvicorn.run("main:app", host="0.0.0.0", port=8050, reload=True, proxy_headers=True, forwarded_allow_ips='*')
