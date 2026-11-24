"""Acceptance only: drive a fresh PTY with synthetic answers, never real credentials."""
import json, os, pty, select, signal, sys, time

spec = json.load(open(sys.argv[1], encoding='utf8'))
pid, fd = pty.fork()
if pid == 0:
    os.execve(spec['command'], [spec['command']] + spec['args'], os.environ)
transcript = b''
status = None
try:
    for step in spec['steps']:
        deadline = time.monotonic() + 20
        while step['wait'].encode() not in transcript:
            if time.monotonic() > deadline:
                raise RuntimeError('Timed out waiting for terminal prompt: ' + step['wait'])
            if select.select([fd], [], [], .1)[0]:
                transcript += os.read(fd, 65536)
        os.write(fd, step['text'].encode())
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if select.select([fd], [], [], .1)[0]:
            try:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                transcript += chunk
            except OSError:
                break
    _, status = os.waitpid(pid, 0)
    for secret in spec.get('secrets', []):
        if secret.encode() in transcript:
            raise RuntimeError('Secret appeared in terminal output')
    if os.waitstatus_to_exitcode(status) != spec.get('exitCode', 0):
        raise RuntimeError('Unexpected terminal exit: ' + transcript.decode(errors='replace'))
    print(json.dumps({'ok': True, 'noEcho': True, 'output': transcript.decode(errors='replace')}))
finally:
    if status is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(fd)
