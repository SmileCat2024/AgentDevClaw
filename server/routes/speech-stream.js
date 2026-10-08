import { WebSocketServer, WebSocket } from 'ws';

import { createClawLogger } from '../shared/claw-logger.js';
import { readSpeechModelConfig } from './model-config.js';

/**
 * speech-stream.js — 流式语音识别 WS 代理
 *
 * 链路：浏览器 (16kHz int16 mono PCM) ⇄ Claw server ⇄ 上游流式 ASR。
 * 浏览器不直连上游：远程访问场景下 baseUrl 中的 127.0.0.1 指的是 Claw
 * server 所在机器，只有 server 侧代理能正确寻址（与非流式 ASR 代理同一
 * 收口原则）。
 *
 * Claw 侧 WS 协议（归一事件，前端只依赖这一套）：
 *   client → server  text   {"op":"start"} / {"op":"stop"}
 *                     binary int16 PCM @16kHz mono 帧
 *   server → client  text   {"type":"ready"}
 *                            {"type":"partial","text"}   当前段未固化增量文本
 *                            {"type":"committed","text"} 段固化（长录音自动分段）
 *                            {"type":"final","text"}     stop 后的最终全文
 *                            {"type":"error","message"}
 *   close code  4400 配置不满足（apiType 非 audio-stream / 未配置）
 *               4001 上游不可达或中途断开
 *
 * 上游适配：当前唯一流式上游为 Qwen-ASR WS 协议（op:start/stop + binary
 * 帧；事件 ready/partial/committed/final/error），与归一事件一一映射；
 * ack 是服务端音频回执，不下发。协议不同的流式上游接入时在本文件适配，
 * Claw 侧协议保持稳定。
 *
 * 生命周期：一次连接承载一次录音（前端 startVoiceRecording 建连、final
 * 后主动关闭）。上游支持连接复用，将来需要再演进，不在本层假设。
 */
const log = createClawLogger('speech-stream');

export const SPEECH_STREAM_PATH = '/protoclaw/speech_stream';

// Claw 侧 ready = 管道就绪（upstream 已连接），此后 start/音频帧按序到达
// 即会被转发。上游协议自身的 ready 回执（收到 start 后的应答）不映射，
// 避免前端收到两个 ready。
const UPSTREAM_EVENT_MAP = {
  partial: 'partial',
  committed: 'committed',
  final: 'final',
  error: 'error',
};

function resolveUpstreamUrl(baseUrl) {
  return baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/audio/stream';
}

export function setupSpeechStreamProxy(httpServer, options = {}) {
  const readConfig = options.readSpeechConfig || readSpeechModelConfig;
  const wss = new WebSocketServer({ noServer: true });

  // 当前进程内唯一的 upgrade 处理者：本路径接管，其余路径无处理者，直接
  // 拒绝避免连接悬挂。将来出现第二个 WS 端点时，此处应演进为按路径分发。
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== SPEECH_STREAM_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      wss.emit('connection', clientWs, req);
    });
  });

  wss.on('connection', (clientWs) => {
    // 上游 open 前到达的 client 消息（start / 音频帧）先缓冲，open 后按序
    // flush——麦克风采集在 WS 握手完成前就可能推第一帧。
    const pending = [];
    let upstreamWs = null;
    let upstreamOpen = false;
    let closed = false;

    const closeClient = (code, message) => {
      if (closed) return;
      closed = true;
      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.send(JSON.stringify({ type: 'error', message }));
        } catch { /* client already gone */ }
        clientWs.close(code, message);
      } else {
        clientWs.terminate();
      }
      if (upstreamWs) {
        upstreamWs.removeAllListeners('message');
        upstreamWs.close();
      }
    };

    clientWs.on('message', (data, isBinary) => {
      if (closed) return;
      if (!upstreamOpen) {
        pending.push([data, isBinary]);
        return;
      }
      if (isBinary) {
        upstreamWs.send(data, { binary: true });
        return;
      }
      try {
        const cmd = JSON.parse(data.toString());
        if (cmd?.op === 'start' || cmd?.op === 'stop') {
          upstreamWs.send(JSON.stringify({ op: cmd.op }));
        }
        // 其他 op 一律忽略：归一层管住 Claw 侧协议面
      } catch {
        log.warn('ignoring non-JSON client message');
      }
    });

    clientWs.on('close', () => {
      if (closed) return;
      closed = true;
      if (upstreamWs) {
        upstreamWs.removeAllListeners('message');
        upstreamWs.close();
      }
    });
    clientWs.on('error', (err) => {
      log.warn('client socket error', err?.message);
      closeClient(4001, 'client connection error');
    });

    const startUpstream = async () => {
      let speechConfig;
      try {
        ({ speechModel: speechConfig } = await readConfig());
      } catch (err) {
        log.error('failed to read speech config', err?.message);
        closeClient(4400, 'failed to read speech model config');
        return;
      }
      if (!speechConfig || !speechConfig.baseUrl || !speechConfig.apiKey) {
        closeClient(4400, 'speech model not configured');
        return;
      }
      if (speechConfig.apiType !== 'audio-stream') {
        closeClient(4400, 'speech model apiType is not audio-stream');
        return;
      }

      const upstreamUrl = resolveUpstreamUrl(speechConfig.baseUrl);
      try {
        upstreamWs = new WebSocket(upstreamUrl, {
          headers: { Authorization: `Bearer ${speechConfig.apiKey}` },
        });
      } catch (err) {
        log.error('failed to construct upstream connection', err?.message);
        closeClient(4001, 'invalid upstream url');
        return;
      }

      upstreamWs.on('open', () => {
        if (closed) {
          upstreamWs.close();
          return;
        }
        upstreamOpen = true;
        clientWs.send(JSON.stringify({ type: 'ready' }));
        for (const [data, isBinary] of pending) {
          if (isBinary) upstreamWs.send(data, { binary: true });
          else {
            try {
              const cmd = JSON.parse(data.toString());
              if (cmd?.op === 'start' || cmd?.op === 'stop') {
                upstreamWs.send(JSON.stringify({ op: cmd.op }));
              }
            } catch { /* already warned at buffer time is not guaranteed; skip */ }
          }
        }
        pending.length = 0;
      });

      upstreamWs.on('message', (data, isBinary) => {
        if (closed || isBinary) return;
        let event;
        try {
          event = JSON.parse(data.toString());
        } catch {
          log.warn('ignoring non-JSON upstream message');
          return;
        }
        const type = UPSTREAM_EVENT_MAP[event?.event];
        if (!type) return; // ack 等服务端回执不下发
        const payload = type === 'error'
          ? { type, message: event.message || 'upstream error' }
          : type === 'ready' ? { type } : { type, text: event.text ?? '' };
        clientWs.send(JSON.stringify(payload));
      });

      upstreamWs.on('error', (err) => {
        log.warn('upstream connection error', err?.message);
        closeClient(4001, upstreamOpen ? 'upstream connection error' : 'upstream unavailable');
      });

      upstreamWs.on('close', () => {
        if (closed) return;
        log.info('upstream closed unexpectedly');
        closeClient(4001, 'upstream closed');
      });
    };

    startUpstream();
  });

  return wss;
}
