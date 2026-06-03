/**
 * live-panel/types.ts — 右侧实时操作面板的类型定义
 */

/** 终端输出行 */
export interface TerminalLine {
  text: string
  stream: 'stdout' | 'stderr'
}

/** 文件预览类型 */
export type PreviewFileType = 'office' | 'pdf' | 'image' | 'video' | 'markdown' | 'text' | 'html' | 'mindmap'

/** 文件预览状态 */
export interface PreviewFileInfo {
  url: string
  fileName: string
  fileType: PreviewFileType
}

/** 产出文件类型 */
export interface ArtifactItem {
  url: string
  fileName: string
  fileType: PreviewFileType | 'unknown'
  /** 产出时间（用于排序） */
  timestamp: number
}

/** 沙箱状态 */
export type SandboxStatus = 'idle' | 'busy' | 'offline'

/** 面板 tab 类型 */
export type LivePanelTab = 'browser' | 'terminal' | 'preview' | 'artifacts'

/** 工具执行日志条目类型 */
export interface ToolLogEntry {
  type: string
  ts?: number
  data?: string
  stream?: 'stdout' | 'stderr'
  tool?: string
  input?: Record<string, unknown>
  result?: string | null
  success?: boolean
  agent?: string
  title?: string
  reason?: string
  url?: string
  fileName?: string
  fileType?: string
}
