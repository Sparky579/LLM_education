// OpenAI 兼容工具（JS 版）
// 参考 AITech/src/utils/openai.ts 的返回兼容与流式解析逻辑

export async function chatCompletion(messages, opts = {}) {
  const apiKey = opts.apiKey
  const apiBaseUrl = (opts.apiBaseUrl || '').replace(/\/?$/, '')
  const model = opts.model
  const temperature = opts.temperature

  if (!apiKey || !apiBaseUrl) {
    throw new Error('请先填写 api_base_url 与 api_key')
  }

  const resp = await fetch(`${apiBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, temperature, messages }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`模型请求失败: ${resp.status} ${resp.statusText} - ${text}`)
  }

  const data = await resp.json()
  const choices = data && data.choices
  let content
  if (Array.isArray(choices) && choices.length > 0) {
    const ch = choices[0]
    content = ch && ch.message && ch.message.content
    if (!content && typeof (ch && ch.text) === 'string') content = ch.text
    if (!content && Array.isArray(ch && ch.content) && ch.content.length > 0) {
      const first = ch.content[0]
      if (typeof first === 'string') content = first
      else if (first && typeof first.text === 'string') content = first.text
    }
    if (!content && Array.isArray(ch && ch.message && ch.message.content) && ch.message.content.length > 0) {
      const first = ch.message.content[0]
      if (typeof first === 'string') content = first
      else if (first && typeof first.text === 'string') content = first.text
    }
  }

  if (!content || typeof content !== 'string' || content.trim() === '') {
    throw new Error(
      `模型返回空内容或非文本。请检查是否使用了 OpenAI 兼容的接口与模型。\n` +
        `model=${model} base=${apiBaseUrl}\n` +
        `原始响应片段：${safeStringify(data)}`,
    )
  }
  return content
}

export async function chatCompletionStream(messages, handlers = {}, opts = {}) {
  const apiKey = opts.apiKey
  const apiBaseUrl = (opts.apiBaseUrl || '').replace(/\/?$/, '')
  const model = opts.model
  const temperature = opts.temperature

  if (!apiKey || !apiBaseUrl) {
    throw new Error('请先填写 api_base_url 与 api_key')
  }

  const resp = await fetch(`${apiBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, temperature, messages, stream: true }),
  })
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '')
    throw new Error(`模型流式请求失败: ${resp.status} ${resp.statusText} - ${text}`)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let processedEvents = 0
  const yieldIfNeeded = async () => {
    processedEvents++
    if (processedEvents % 40 === 0) {
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // 统一换行
      buf = buf.replace(/\r\n/g, '\n')
      // 尝试按两行分隔（SSE 标准）
      let sepIndex
      while ((sepIndex = buf.indexOf('\n\n')) !== -1) {
        const eventChunk = buf.slice(0, sepIndex)
        buf = buf.slice(sepIndex + 2)
        processEventChunk(eventChunk, handlers)
        await yieldIfNeeded()
      }
      // 兼容仅按单行推送的实现：若存在完整行也尝试处理
      const lastNl = buf.lastIndexOf('\n')
      if (lastNl !== -1) {
        const linesChunk = buf.slice(0, lastNl)
        buf = buf.slice(lastNl + 1)
        const maybeEvents = linesChunk.split('\n')
        for (const ln of maybeEvents) {
          processEventChunk(ln, handlers)
          await yieldIfNeeded()
        }
      }
    }
  } catch (err) {
    handlers.onError && handlers.onError(err)
    throw err
  } finally {
    try {
      reader.releaseLock()
    } catch (e) {}
  }
  handlers.onDone && handlers.onDone()
}

export function separateThinkTokens(chunk, state) {
  let visible = ''
  let thinkDelta = ''
  let i = 0
  while (i < chunk.length) {
    if (!state.inThink) {
      const start = chunk.indexOf('<think>', i)
      if (start === -1) {
        visible += chunk.slice(i)
        break
      }
      visible += chunk.slice(i, start)
      i = start + '<think>'.length
      state.inThink = true
    } else {
      const end = chunk.indexOf('</think>', i)
      if (end === -1) {
        const piece = chunk.slice(i)
        state.thinkBuffer += piece
        thinkDelta += piece
        break
      }
      const piece = chunk.slice(i, end)
      state.thinkBuffer += piece
      thinkDelta += piece
      i = end + '</think>'.length
      state.inThink = false
    }
  }
  return { visible, thinkDelta }
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj, (k, v) => (typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v))
  } catch (e) {
    return '[unserializable]'
  }
}

function processEventChunk(chunk, handlers) {
  const text = (chunk || '').replace(/\r\n/g, '\n')
  if (!text.trim()) return
  // SSE 事件块可能包含多行，其中多行 data: 需要拼接
  const lines = text.split('\n')
  let dataLines = []
  for (const rawLine of lines) {
    const ln = rawLine.trim()
    if (!ln) continue
    if (ln === '[DONE]' || ln === 'data: [DONE]') {
      handlers.onDone && handlers.onDone()
      return
    }
    if (ln.startsWith('data:')) {
      dataLines.push(ln.slice(5).trim())
    }
  }
  if (dataLines.length === 0) {
    // 有些实现直接推送 JSON 行
    if (text.trim().startsWith('{')) dataLines = [text.trim()]
  }
  for (const payloadRaw of dataLines) {
    const payload = payloadRaw
    if (!(payload.startsWith('{') && (payload.endsWith('}') || payload.endsWith('}\n')))) {
      continue
    }
    try {
      const json = JSON.parse(payload)
      const ch = json && json.choices && json.choices[0]
      if (!ch) continue
      // 跳过仅包含角色的事件
      if (ch.delta && ch.delta.role && !ch.delta.content) continue
      let token = ch && ch.delta && ch.delta.content
      if (!token && typeof (ch && ch.text) === 'string') token = ch.text
      if (!token && Array.isArray(ch && ch.delta && ch.delta.content) && ch.delta.content[0]) {
        token = (ch.delta.content[0] && ch.delta.content[0].text) || ch.delta.content[0]
      }
      if (typeof token === 'string' && token.length) {
        // 强制在微任务后渲染，减少批处理卡顿
        Promise.resolve().then(() => handlers.onDelta && handlers.onDelta(token))
      }
    } catch (e) {
      // 忽略无法解析的片段
    }
  }
}


