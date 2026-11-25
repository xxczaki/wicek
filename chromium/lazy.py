import asyncio
import os
import signal
import sys

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = int(os.environ.get("CHROMIUM_LISTEN_PORT", "9222"))
DEBUG_PORT = int(os.environ.get("CHROMIUM_DEBUG_PORT", "9223"))
LAUNCH_COMMAND = os.environ.get("CHROMIUM_LAUNCH", "/usr/local/bin/chromium-launch")
IDLE_SECONDS = float(os.environ.get("CHROMIUM_IDLE_SECONDS", "300"))
STARTUP_TIMEOUT_SECONDS = 30
STOP_TIMEOUT_SECONDS = 10
CONNECT_RETRY_SECONDS = 0.2
PIPE_CHUNK_BYTES = 65536


class LazyBrowser:
    def __init__(self, launch_args: list[str]):
        self.launch_args = launch_args
        self.process: asyncio.subprocess.Process | None = None
        self.lock = asyncio.Lock()
        self.open_connections = 0
        self.idle_timer: asyncio.TimerHandle | None = None

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.open_connections += 1
        self.cancel_idle_timer()
        try:
            upstream_reader, upstream_writer = await self.connect()
        except (OSError, TimeoutError) as error:
            log(f"could not reach Chromium: {error}")
            writer.close()
            self.release()
            return
        try:
            await asyncio.gather(
                pipe(reader, upstream_writer), pipe(upstream_reader, writer)
            )
        finally:
            self.release()

    async def connect(self):
        async with self.lock:
            if not self.is_running():
                await self.start()
            deadline = asyncio.get_running_loop().time() + STARTUP_TIMEOUT_SECONDS
            while True:
                try:
                    return await asyncio.open_connection(LISTEN_HOST, DEBUG_PORT)
                except OSError:
                    if not self.is_running():
                        raise OSError("Chromium exited during startup")
                    if asyncio.get_running_loop().time() > deadline:
                        raise TimeoutError("Chromium did not open its debugging port")
                    await asyncio.sleep(CONNECT_RETRY_SECONDS)

    async def start(self):
        log("starting Chromium")
        self.process = await asyncio.create_subprocess_exec(
            LAUNCH_COMMAND,
            *self.launch_args,
            env={**os.environ, "CHROMIUM_DEBUG_PORT": str(DEBUG_PORT)},
            start_new_session=True,
        )

    async def stop(self):
        async with self.lock:
            if self.open_connections or not self.is_running():
                return
            log("stopping idle Chromium")
            await terminate(self.process)
            self.process = None

    def is_running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    def release(self):
        self.open_connections -= 1
        if self.open_connections == 0:
            self.idle_timer = asyncio.get_running_loop().call_later(
                IDLE_SECONDS, lambda: asyncio.ensure_future(self.stop())
            )

    def cancel_idle_timer(self):
        if self.idle_timer:
            self.idle_timer.cancel()
            self.idle_timer = None


async def main():
    browser = LazyBrowser(sys.argv[1:])
    server = await asyncio.start_server(browser.handle, LISTEN_HOST, LISTEN_PORT)
    log(f"listening on {LISTEN_HOST}:{LISTEN_PORT}, Chromium starts on first use")

    shutdown = asyncio.Event()
    for signal_number in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(signal_number, shutdown.set)
    await shutdown.wait()

    server.close()
    if browser.is_running():
        await terminate(browser.process)


async def pipe(source: asyncio.StreamReader, destination: asyncio.StreamWriter):
    try:
        while chunk := await source.read(PIPE_CHUNK_BYTES):
            destination.write(chunk)
            await destination.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        destination.close()


async def terminate(process: asyncio.subprocess.Process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
        await asyncio.wait_for(process.wait(), STOP_TIMEOUT_SECONDS)
    except TimeoutError:
        os.killpg(process.pid, signal.SIGKILL)
        await process.wait()
    except ProcessLookupError:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def log(message: str):
    print(f"chromium-run: {message}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
