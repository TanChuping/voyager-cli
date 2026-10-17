/** Serve's log: one line per entry on stderr, which the daemon points at `logs/serve.log`. */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  write: (line: string) => void = (line) => process.stderr.write(line),
): Logger {
  const emit = (level: string, message: string, fields?: Record<string, unknown>): void => {
    const extra = fields === undefined ? '' : ` ${JSON.stringify(fields)}`;
    write(`${new Date().toISOString()} ${level} ${message}${extra}\n`);
  };
  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
