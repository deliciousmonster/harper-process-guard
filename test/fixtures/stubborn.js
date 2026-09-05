// Stays up and ignores SIGTERM, so the escalation to SIGKILL has something to escalate against. POSIX
// only: on Windows this handler is never called, because process.kill there terminates outright.
// "ready" goes out only once the handler is installed: a process appears in the process table the
// instant it is exec'd, which is long before the script that ignores the signal has run.
process.on('SIGTERM', () => {});
setInterval(() => {}, 1 << 30);
process.stdout.write('ready\n');
