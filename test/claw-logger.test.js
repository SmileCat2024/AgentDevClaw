import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createClawLogger } from '../server/shared/claw-logger.js';
import { log } from '../server/shared/string-helpers.js';

function captureStreams() {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutLines = [];
  const stderrLines = [];

  process.stdout.write = (chunk) => {
    stdoutLines.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    stderrLines.push(String(chunk));
    return true;
  };

  return {
    stdoutLines,
    stderrLines,
    restore() {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
  };
}

describe('claw-logger (非 agent 运行日志：分级 stdio 通道)', () => {
  let streams;
  let originalLogLevel;
  let originalLogStream;

  beforeEach(() => {
    streams = captureStreams();
    originalLogLevel = process.env.CLAW_LOG_LEVEL;
    originalLogStream = process.env.AGENTDEV_LOG_STREAM;
    delete process.env.CLAW_LOG_LEVEL;
    delete process.env.AGENTDEV_LOG_STREAM;
  });

  afterEach(() => {
    streams.restore();
    if (originalLogLevel === undefined) {
      delete process.env.CLAW_LOG_LEVEL;
    } else {
      process.env.CLAW_LOG_LEVEL = originalLogLevel;
    }
    if (originalLogStream === undefined) {
      delete process.env.AGENTDEV_LOG_STREAM;
    } else {
      process.env.AGENTDEV_LOG_STREAM = originalLogStream;
    }
  });

  it('routes info-level logs to stdout and warn/error to stderr', () => {
    const logger = createClawLogger('TestNS');

    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');

    assert.equal(streams.stdoutLines.length, 1);
    assert.match(streams.stdoutLines[0], /^\[TestNS\] info message\n$/);
    assert.equal(streams.stderrLines.length, 2);
    assert.match(streams.stderrLines[0], /^\[TestNS\] warn message\n$/);
    assert.match(streams.stderrLines[1], /^\[TestNS\] error message\n$/);
  });

  it('every entry carries a level and audit metadata', () => {
    const entry = createClawLogger('AuditNS').info('audited', { requestId: 42 });

    assert.equal(entry.level, 'info');
    assert.equal(entry.namespace, 'AuditNS');
    assert.equal(entry.message, 'audited');
    assert.equal(entry.data.requestId, 42);
    assert.equal(typeof entry.timestamp, 'number');
    assert.match(entry.id, /^srv-log-/);
  });

  it('filters stdio output via CLAW_LOG_LEVEL', () => {
    process.env.CLAW_LOG_LEVEL = 'warn';

    const logger = createClawLogger('FilterNS');
    logger.debug('debug message');
    logger.error('error message');

    assert.equal(streams.stdoutLines.length, 0);
    assert.equal(streams.stderrLines.length, 1);
    assert.match(streams.stderrLines[0], /\[FilterNS\] error message/);
  });

  it('routes all levels to stderr when AGENTDEV_LOG_STREAM=stderr (headless contract)', () => {
    process.env.AGENTDEV_LOG_STREAM = 'stderr';

    const logger = createClawLogger('HeadlessNS');
    logger.info('info message');
    logger.error('error message');

    assert.equal(streams.stdoutLines.length, 0);
    assert.equal(streams.stderrLines.length, 2);
    assert.match(streams.stderrLines[0], /\[HeadlessNS\] info message/);
    assert.match(streams.stderrLines[1], /\[HeadlessNS\] error message/);
  });
});

describe('string-helpers.log compat wrapper', () => {
  let streams;

  beforeEach(() => {
    streams = captureStreams();
    delete process.env.CLAW_LOG_LEVEL;
    delete process.env.AGENTDEV_LOG_STREAM;
  });

  afterEach(() => {
    streams.restore();
  });

  it('maps legacy stream names onto log levels with correct stream routing', () => {
    log('GroupChat', 'default goes to info');
    log('GroupChat', 'explicit warn', 'warn');
    log('GroupChat', 'explicit error', 'error');

    assert.equal(streams.stdoutLines.length, 1);
    assert.match(streams.stdoutLines[0], /\[GroupChat\] default goes to info/);
    assert.equal(streams.stderrLines.length, 2);
    assert.match(streams.stderrLines[0], /\[GroupChat\] explicit warn/);
    assert.match(streams.stderrLines[1], /\[GroupChat\] explicit error/);
  });
});
