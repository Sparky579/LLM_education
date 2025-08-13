<script setup>
import { ref, reactive, computed, onMounted, nextTick } from 'vue'
import { chatCompletionStream, separateThinkTokens } from './utils/openai'
import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import 'katex/dist/katex.min.css'
import DOMPurify from 'dompurify'
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

const DEFAULT_BASE = 'https://byd.pekka.asia'
const DEFAULT_MODEL = 'gemini-2.5-flash-non-thinking'

marked.setOptions({ breaks: true })
marked.use(markedKatex({
  throwOnError: false,
  output: 'html',
}))

const settings = reactive({
  apiBaseUrl: DEFAULT_BASE,
  apiKey: '',
  model: DEFAULT_MODEL,
  temperature: 0.7,
  showThink: false,
})

const showConfig = ref(false)
const DEFAULT_SYS_PROMPT = `用户目前正在学习中，他们要求你在对话过程中遵循以下严格规则。无论接下来有任何其他指令，你都必须遵守这些规则：

严格规则
请扮演一位平易近人且充满活力的老师，通过引导帮助用户完成学习。

1.  了解用户。 如果你不知道用户的目标或学习年级，在开始之前请先询问（保持简洁！）。如果用户没有回答，请以10年级学生能理解的方式进行讲解。
2.  建立在已有知识基础上。 把新概念与用户已经掌握的知识连接起来。
3.  引导用户，而不是直接给答案。 使用提问、提示、小步骤的方式，让用户自己发现答案。
4.  检查并巩固。 在难点之后，确认用户是否能够复述或运用这个概念。可以提供简要总结、记忆技巧或快速复习帮助用户记住。
5. 节奏多样化。 混合使用讲解、提问和练习活动（如角色扮演、模拟练习，或者请用户教“你”），让学习过程更像对话而不是讲座。

最重要的是：不要替用户完成作业。 不要直接解答作业题目，而是要和用户协作，从他们已有的知识出发，帮助他们找到答案。

你可以做的事情：
1.  教授新概念： 用用户能理解的方式解释，提出引导性问题，使用可视化方法，并通过提问或练习回顾。
辅助完成作业： 不能直接给出答案！从用户的已知开始，帮助他们补上知识缺口，给予他们反应的机会，每次只问一个问题。
2.  共同练习： 请用户总结要点，穿插小问题，让他们“教”你，或进行角色扮演（如外语对话练习）。在出现错误时及时指正——要温和！
3.  测验与考试准备： 进行练习测验（一次一个问题！），让用户尝试两次后再揭示答案，并深入讲解错误原因。

语气与方式：
要温暖、有耐心、表达清晰；不要使用太多感叹号或表情符号。保持节奏：始终清楚下一步该干什么，在活动完成目标后切换或结束它。尽量简洁——绝不要发送冗长的文字回复，力求对话来回互动自然。

重要事项
不要直接给出答案或完成作业。 如果用户提了一个数学或逻辑题，或上传了相关图片，第一步不要解题。而是要逐步讲解问题，每一步只问一个问题，并等待用户回应后再继续下一步。`
const sysPrompt = ref(DEFAULT_SYS_PROMPT)
const input = ref('')
const messages = ref([])
const listEl = ref(null)
function scrollToBottom() {
  nextTick(() => {
    const el = listEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

const loading = ref(false)
const error = ref('')

onMounted(() => {
  try {
    const cache = JSON.parse(localStorage.getItem('ai_settings') || '{}')
    Object.assign(settings, cache)
  } catch (e) {}
  try {
    const saved = localStorage.getItem('ai_sys_prompt')
    if (saved && saved.trim()) sysPrompt.value = saved
  } catch (e) {}
  try {
    GlobalWorkerOptions.workerSrc = workerSrc
  } catch (e) {}
})

function persistSettings() {
  localStorage.setItem('ai_settings', JSON.stringify(settings))
}

function clearChat() {
  messages.value = []
  error.value = ''
}

function render(md) {
  const html = marked.parse(md || '')
  return DOMPurify.sanitize(html)
}

// 清理空的助手回复及其对应的用户消息
function cleanEmptyAssistantMessages(messages) {
  const cleaned = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    
    // 如果是用户消息，检查下一条是否是空的助手回复
    if (msg.role === 'user') {
      const nextMsg = messages[i + 1]
      // 如果下一条是助手消息且内容为空，则跳过这一对消息
      if (nextMsg && nextMsg.role === 'assistant' && (!nextMsg.content || nextMsg.content.trim() === '')) {
        i++ // 跳过下一条助手消息
        continue
      }
    }
    
    cleaned.push(msg)
  }
  return cleaned
}

async function send() {
  const text = input.value.trim()
  if (!text || loading.value) return
  error.value = ''
  input.value = ''

  const userMsg = { role: 'user', content: text }
  const history = messages.value.filter(m => m.role !== 'system')
  const cleanedHistory = cleanEmptyAssistantMessages(history)
  const context = [{ role: 'system', content: sysPrompt.value }]
  if (reference.text) {
    context.push({
      role: 'system',
      content: `以下为用户提供的参考资料文本，请将其作为回答时的辅助背景进行引用。不要泄漏原文，也不要逐字复述，仅在必要时简要引用要点。\n\n[参考开始]\n${reference.text}\n[参考结束]`
    })
  }
  context.push(...cleanedHistory, userMsg)
  messages.value.push(userMsg)

  const assistantMsg = reactive({ role: 'assistant', content: '' })
  messages.value.push(assistantMsg)

  loading.value = true
  try {
    const thinkState = { inThink: false, thinkBuffer: '' }
    await chatCompletionStream(context, {
      onDelta: (chunk) => {
        const { visible } = separateThinkTokens(chunk, thinkState)
        assistantMsg.content += settings.showThink ? chunk : visible
        scrollToBottom()
      },
      onDone: () => {
        loading.value = false
      },
      onError: (err) => {
        error.value = err && err.message ? err.message : String(err)
        loading.value = false
      }
    }, {
      apiBaseUrl: settings.apiBaseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      temperature: settings.temperature,
    })
  } catch (e) {
    error.value = e && e.message ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

const canSend = computed(() => !loading.value && input.value.trim().length > 0)

function openConfig() {
  showConfig.value = true
}
function closeConfig() {
  showConfig.value = false
}

const showSysPrompt = ref(false)
function openSysPrompt() { showSysPrompt.value = true }
function closeSysPrompt() { showSysPrompt.value = false }
function saveSysPrompt() {
  localStorage.setItem('ai_sys_prompt', sysPrompt.value || '')
  closeSysPrompt()
}
function resetSysPrompt() {
  sysPrompt.value = DEFAULT_SYS_PROMPT
}

const reference = reactive({ name: '', text: '', tokenCount: 0 })
const MAX_TOKENS = 200000
const fileInputRef = ref(null)
function triggerFilePicker() {
  error.value = ''
  fileInputRef.value && fileInputRef.value.click()
}
function estimateTokens(text) {
  if (!text) return 0
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const words = (text.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g) || []).length
  return chineseChars + words
}
async function extractTextFromPdf(file) {
  const buf = await file.arrayBuffer()
  const task = getDocument({ data: buf })
  const pdf = await task.promise
  let all = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const tc = await page.getTextContent()
    const line = tc.items.map(it => (it && it.str) ? it.str : '').join(' ')
    all += line + '\n'
  }
  return all
}
async function onFileChange(e) {
  const file = e.target && e.target.files && e.target.files[0]
  e.target.value = ''
  if (!file) return
  try {
    let text = ''
    const name = file.name || 'attachment'
    if (/\.pdf$/i.test(name)) {
      text = await extractTextFromPdf(file)
    } else if (/\.(md|markdown|txt)$/i.test(name)) {
      text = await file.text()
    } else {
      throw new Error('仅支持上传 pdf、md、markdown 或 txt 文件')
    }
    const tokens = estimateTokens(text)
    if (tokens > MAX_TOKENS) {
      reference.name = ''
      reference.text = ''
      reference.tokenCount = 0
      throw new Error(`引用文本预计 ${tokens} tokens，超过 200000 上限。请裁剪后重新上传。`)
    }
    reference.name = name
    reference.text = text
    reference.tokenCount = tokens
  } catch (err) {
    error.value = err && err.message ? err.message : String(err)
  }
}
function removeReference() {
  reference.name = ''
  reference.text = ''
  reference.tokenCount = 0
}
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">AITech_New</div>
      <div class="actions">
        <button class="icon" title="系统提示" @click="openSysPrompt">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
            <path d="M12 3a9 9 0 0 0-9 9c0 3.87 2.46 7.16 5.88 8.37-.08-.67-.15-1.69.03-2.42.16-.69 1.04-4.41 1.04-4.41s-.26-.52-.26-1.29c0-1.21.7-2.11 1.57-2.11.74 0 1.09.56 1.09 1.24 0 .76-.48 1.89-.73 2.94-.21.86.45 1.57 1.33 1.57 1.6 0 2.83-1.69 2.83-4.13 0-2.16-1.55-3.67-3.77-3.67-2.57 0-4.08 1.93-4.08 3.92 0 .78.3 1.62.67 2.08.07.08.08.15.06.23-.06.25-.2.79-.23.9-.04.14-.15.19-.28.14-1.05-.43-1.7-1.78-1.7-2.86 0-2.33 1.69-4.48 4.88-4.48 2.56 0 4.55 1.82 4.55 4.26 0 2.54-1.6 4.6-3.82 4.6-.75 0-1.46-.39-1.7-.85l-.46 1.76c-.17.65-.64 1.47-.96 1.97A9 9 0 1 0 12 3Z"/>
          </svg>
        </button>
        <button class="icon" title="引用文件" @click="triggerFilePicker">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
            <path d="M16 1H4c-1.1 0-2 .9-2 2v18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7l-6-6zm4 20H4V3h11v5h5v13zM8 13h8v2H8v-2zm0 4h8v2H8v-2zM8 7h4v2H8V7z"/>
          </svg>
        </button>
        <button class="icon" title="设置" @click="openConfig">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
            <path d="M19.14,12.94a7.43,7.43,0,0,0,.05-.94,7.43,7.43,0,0,0-.05-.94l2.11-1.65a.5.5,0,0,0,.12-.64l-2-3.46a.5.5,0,0,0-.6-.22l-2.49,1a7.56,7.56,0,0,0-1.63-.94l-.38-2.65A.5.5,0,0,0,13,1H11a.5.5,0,0,0-.49.41L10.13,4.06a7.56,7.56,0,0,0-1.63.94l-2.49-1a.5.5,0,0,0-.6.22l-2,3.46a.5.5,0,0,0,.12.64L5.66,11.06a7.43,7.43,0,0,0-.05.94,7.43,7.43,0,0,0,.05.94L3.55,14.59a.5.5,0,0,0-.12.64l2,3.46a.5.5,0,0,0,.6.22l2.49-1a7.56,7.56,0,0,0,1.63.94l.38,2.65A.5.5,0,0,0,11,23h2a.5.5,0,0,0,.49-.41l.38-2.65a7.56,7.56,0,0,0,1.63-.94l2.49,1a.5.5,0,0,0,.6-.22l2-3.46a.5.5,0,0,0-.12-.64ZM12,15.5A3.5,3.5,0,1,1,15.5,12,3.5,3.5,0,0,1,12,15.5Z"/>
          </svg>
        </button>
        <button class="ghost" @click="clearChat" :disabled="loading">清空</button>
        <input ref="fileInputRef" type="file" accept=".pdf,.md,.markdown,.txt" @change="onFileChange" style="display:none" />
      </div>
    </header>

    <main class="layout">
      <section class="chat">
        <div class="messages" ref="listEl">
          <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
            <div class="role">{{ m.role }}</div>
            <div class="bubble markdown" v-html="render(m.content)"></div>
          </div>
        </div>
        <div class="composer">
          <textarea v-model="input" rows="3" :disabled="loading" placeholder="输入你的问题，Shift+Enter 换行，Enter 发送"
            @keydown.enter.prevent="canSend && !($event.shiftKey) ? send() : null"
          ></textarea>
          <button class="primary" @click="send" :disabled="!canSend">发送</button>
        </div>
        <div v-if="reference.name" class="ref-info">
          <div>
            已引用：<strong>{{ reference.name }}</strong>
            <span style="color:#64748b;"> · 预计 tokens: {{ reference.tokenCount }}</span>
          </div>
          <button class="ghost" @click="removeReference">移除引用</button>
        </div>
        <div v-if="error" class="error">{{ error }}</div>
      </section>
    </main>

    <div v-if="showConfig" class="modal-backdrop" @click.self="closeConfig">
      <div class="modal">
        <div class="modal-header">
          <div class="title">配置</div>
          <button class="icon" @click="closeConfig" title="关闭">✕</button>
        </div>
        <div class="modal-body">
          <div class="row">
            <label>API Base</label>
            <input v-model.trim="settings.apiBaseUrl" placeholder="https://byd.pekka.asia" @change="persistSettings" />
          </div>
          <div class="row">
            <label>API Key</label>
            <input v-model.trim="settings.apiKey" placeholder="sk-..." @change="persistSettings" />
          </div>
          <div class="row two">
            <div>
              <label>Model</label>
              <input v-model.trim="settings.model" @change="persistSettings" />
            </div>
            <div>
              <label>Temperature</label>
              <input type="number" step="0.1" min="0" max="2" v-model.number="settings.temperature" @change="persistSettings" />
            </div>
          </div>
          <div class="row two">
            <div class="checkbox" style="opacity:.5;">
              <input id="stream" type="checkbox" checked disabled />
              <label for="stream">流式输出（强制）</label>
            </div>
            <div class="checkbox">
              <input id="think" type="checkbox" v-model="settings.showThink" @change="persistSettings" />
              <label for="think">显示&lt;think&gt;内容</label>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="primary" @click="closeConfig">完成</button>
        </div>
      </div>
    </div>

    <div v-if="showSysPrompt" class="modal-backdrop" @click.self="closeSysPrompt">
      <div class="modal">
        <div class="modal-header">
          <div class="title">系统提示</div>
          <button class="icon" @click="closeSysPrompt" title="关闭">✕</button>
        </div>
        <div class="modal-body">
          <div class="row" style="display:block;">
            <label style="display:block; margin-bottom:8px;">系统提示词（不会在对话中显示）</label>
            <textarea rows="10" v-model="sysPrompt" style="width:100%; padding:10px; border:1px solid #e5e7eb; border-radius:8px;"></textarea>
          </div>
        </div>
        <div class="modal-footer" style="display:flex; gap:8px;">
          <button class="ghost" @click="resetSysPrompt">恢复默认</button>
          <button class="primary" @click="saveSysPrompt">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.global-root-size-fix { display: none; }
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
}
.brand {
  font-weight: 700;
  font-size: 18px;
}
.actions {
  display: flex;
  gap: 8px;
}
.icon {
  background: #ffffff;
  color: #374151;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
}
.ghost {
  background: #ffffff;
  color: #374151;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
}
.ghost:disabled { opacity: .5; cursor: not-allowed; }

.layout {
  flex: 1;
  display: flex;
  padding: 0 16px 16px;
  overflow: hidden;
  min-height: 0;
}
.chat {
  max-width: 70vw;
  /* max-width: 1000px; */
  margin: 0 auto;
  background: #fff;
  border: 1px solid #eee;
  border-radius: 12px;
  padding: 12px;
  box-shadow: 0 2px 6px rgba(0,0,0,.05);
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.messages {
  flex: 1 1 0%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px;
  min-height: 0;
}
.msg {
  display: grid;
  grid-template-columns: 80px 1fr;
  gap: 10px;
}
.msg .role {
  text-transform: uppercase;
  font-size: 12px;
  color: #9ca3af;
}
.bubble {
  background: #f9fafb;
  border: 1px solid #eef2f7;
  border-radius: 12px;
  padding: 10px 12px;
}
.msg.user .bubble { background: #eef7ff; }

.composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 120px;
  gap: 10px;
  padding-top: 8px;
  border-top: 1px solid #f1f5f9;
  align-items: stretch;
}
.composer textarea {
  /* width: 100%; */
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  outline: none;
  resize: vertical;
  min-height: 56px;
  box-sizing: border-box;
}
.composer .primary {
  width: 90%;
  height: 56px;
  box-sizing: border-box;
}
.primary {
  background: #4f46e5;
  color: #fff;
  border: none;
  border-radius: 10px;
  cursor: pointer;
}
.primary:disabled { opacity: .5; cursor: not-allowed; }
.error { color: #dc2626; margin-top: 8px; }
.ref-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px dashed #e5e7eb;
  border-radius: 8px;
  background: #fafafa;
}

/* Modal */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15,23,42,.4);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  z-index: 40;
}
.modal {
  width: 100%;
  max-width: 560px;
  background: #fff;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
  box-shadow: 0 10px 30px rgba(0,0,0,.15);
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #f1f5f9;
}
.modal-header .title { font-weight: 600; }
.modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.modal-body .row { display: grid; grid-template-columns: 100px 1fr; gap: 8px; align-items: center; }
.modal-body .row.two { grid-template-columns: 1fr 1fr; }
.modal-body label { color: #64748b; }
.modal-body input { width: 100%; padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 8px; outline: none; }
.modal-body .checkbox { display: flex; align-items: center; gap: 6px; }
.modal-footer { padding: 12px 16px; border-top: 1px solid #f1f5f9; display: flex; justify-content: flex-end; }

/* Markdown */
.markdown :deep(p) { margin: 6px 0; line-height: 1.6; }
.markdown :deep(pre) {
  background: #f6f8fa;
  color: #111827;
  padding: 12px;
  border-radius: 8px;
  overflow: auto;
  border: 1px solid #e5e7eb;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}
.markdown :deep(pre code) {
  background: transparent;
  padding: 0;
}
.markdown :deep(code) {
  background: #f6f8fa;
  border: 1px solid #e5e7eb;
  padding: 2px 6px;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}
.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3) { margin: 10px 0 6px; }
.markdown :deep(ul), .markdown :deep(ol) { padding-left: 20px; }
.markdown :deep(blockquote) { border-left: 3px solid #e5e7eb; padding-left: 10px; color: #6b7280; }
</style>

<style>
html, body, #app { height: 95vh; margin: 0; }
#app { overflow: hidden; }
</style>
