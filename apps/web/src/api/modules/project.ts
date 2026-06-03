import request from '@/api/request'

export interface CreateProjectRequest {
  name: string
  description?: string
  icon?: string
  /** 选中的设计风格名称，生成时自动注入提示词 */
  design_style_name?: string
  /** 选中的设计风格简介，生成时自动注入提示词 */
  design_style_desc?: string
}

export interface ProjectRecord {
  id: number
  name: string
  description: string
  icon: string
  user_id: number
  status: number
  /** 项目设计风格名称 */
  design_style_name?: string
  /** 项目设计风格简介 */
  design_style_desc?: string
  created_at: string
  updated_at: string
}

/** 设计风格选项（来自 /api/v1/design-styles 接口） */
export interface DesignStyleItem {
  id: number
  name: string
  /** 风格封面图 */
  url: string
  /** 风格简介，会注入到生成提示词 */
  desc: string
}

export interface StoryboardRecord {
  id: number
  name: string
  description: string
  prompt: string
  script_content: string
  project_id: number
  created_at: string
  updated_at: string
}

export interface CreateStoryboardRequest {
  project_id: number
  name: string
  description?: string
}

export interface HandleProjectScriptRequest {
  project_id: number
  storyboard_id: number
  content: string
}

export type ScriptParseTaskStatus = 'pending' | 'processing' | 'succeeded' | 'failed'

export interface ScriptParseTaskRecord {
  id: number
  project_id: number
  storyboard_id: number
  user_id: number
  status: ScriptParseTaskStatus
  error_message: string
  finished_at: string | null
  created_at: string
  updated_at: string
}

export interface HandleProjectScriptResponse {
  task_id: number
  status: ScriptParseTaskStatus
  project_id: number
  storyboard_id: number
}

export interface ActiveScriptTaskResponse {
  task: ScriptParseTaskRecord | null
}

export interface ProjectParseSummary {
  characters: number
  scenes: number
  items: number
  creatures: number
  fragments: number
}

export interface MaterialRecord {
  id: number
  name: string
  description: string
  type: number
  url: string
  status: number
  prompt: string
  project_id: number
  is_variant?: boolean
  source_material_id?: number | null
  variant_materials?: MaterialRecord[]
  material_items?: MaterialItemRecord[]
  created_at: string
  updated_at: string
}

export interface MaterialItemRecord {
  id: number
  material_id: number
  project_id: number
  kind: number
  name: string
  description: string
  prompt: string
  provider_model:
    | 'grok-imagine-image'
    | 'doubao-seedream-4-0-250828'
    | 'gpt-image-2-reverse'
    | 'gemini-3-pro-image-preview'
    | 'gemini-3.1-flash-image-preview'
    | 'gemini-3-flash-preview-free'
    | string
  mode: 'text_to_image' | 'image_to_image'
  input_images: string
  output_images: string
  url: string
  status: number
  error_message: string
  created_at: string
  updated_at: string
}

export interface MaterialGenerationInput {
  role: 'reference' | 'mask' | 'image'
  url: string
}

export interface CreateMaterialRequest {
  name: string
  description?: string
  prompt?: string
  type: number
  is_variant?: boolean
  source_material_id?: number
}

export interface SubmitMaterialGenerationRequest {
  material_id: number
  model:
    | 'grok-imagine-image'
    | 'doubao-seedream-4-0-250828'
    | 'gpt-image-2-reverse'
    | 'gemini-3-pro-image-preview'
    | 'gemini-3.1-flash-image-preview'
    | 'gemini-3-flash-preview-free'
  mode: 'text_to_image' | 'image_to_image'
  prompt: string
  size: string
  strength: number
  count: number
  inputs: MaterialGenerationInput[]
}

export interface SubmitMaterialGenerationResponse {
  task_ids: number[]
}

export interface QiniuUploadFileResponse {
  key: string
  file_url: string
  expires_in: number
}

export interface PageData<T> {
  list: T[]
  total: number
  page: number
  size: number
}

export const createProjectApi = (payload: CreateProjectRequest) =>
  request.post<ProjectRecord, ProjectRecord>('/v1/projects', payload)

export const getProjectListApi = (params?: { page?: number; page_size?: number }) =>
  request.get<PageData<ProjectRecord>, PageData<ProjectRecord>>('/v1/projects', { params })

export const getProjectByIdApi = (id: number) => request.get<ProjectRecord, ProjectRecord>(`/v1/projects/${id}`)

/** 获取全部设计风格列表（无需登录） */
export const getDesignStylesApi = () =>
  request.get<DesignStyleItem[], DesignStyleItem[]>('/v1/design-styles')

export const createStoryboardApi = (payload: CreateStoryboardRequest) =>
  request.post<StoryboardRecord, StoryboardRecord>('/v1/projects/storyboards', payload)

export const getStoryboardListApi = (projectId: number) =>
  request.get<StoryboardRecord[], StoryboardRecord[]>('/v1/projects/storyboards', {
    params: { project_id: projectId },
  })

export const handleProjectScriptApi = (payload: HandleProjectScriptRequest) =>
  request.post<HandleProjectScriptResponse, HandleProjectScriptResponse>('/v1/projects/handleScript', payload)

export const getScriptTaskApi = (taskId: number) =>
  request.get<ScriptParseTaskRecord, ScriptParseTaskRecord>(`/v1/projects/script-tasks/${taskId}`)

export const getActiveScriptTaskApi = (projectId: number) =>
  request.get<ActiveScriptTaskResponse, ActiveScriptTaskResponse>(`/v1/projects/${projectId}/script-tasks/active`)

export const getProjectParseSummaryApi = (projectId: number) =>
  request.get<ProjectParseSummary, ProjectParseSummary>(`/v1/projects/${projectId}/parse-summary`)

export const getProjectMaterialsApi = (projectId: number, params?: { type?: number }) =>
  request.get<MaterialRecord[], MaterialRecord[]>(`/v1/projects/${projectId}/materials`, {
    params,
  })

export const createMaterialApi = (projectId: number, payload: CreateMaterialRequest) =>
  request.post<MaterialRecord, MaterialRecord>(`/v1/projects/${projectId}/materials`, payload)

export const submitMaterialGenerationApi = (projectId: number, payload: SubmitMaterialGenerationRequest) =>
  request.post<SubmitMaterialGenerationResponse, SubmitMaterialGenerationResponse>(
    `/v1/projects/${projectId}/material-generation-tasks`,
    payload,
  )

export const getMaterialGenerationTaskApi = (taskId: number) =>
  request.get<MaterialItemRecord, MaterialItemRecord>(`/v1/projects/material-generation-tasks/${taskId}`)

export const getMaterialGenerationTasksApi = (taskIds: number[]) =>
  request.get<MaterialItemRecord[], MaterialItemRecord[]>('/v1/projects/material-generation-tasks', {
    params: { ids: taskIds.join(',') },
  })

export const uploadProjectIconApi = (file: File) => {
  const formData = new FormData()
  formData.append('file', file)
  return request.post<QiniuUploadFileResponse, QiniuUploadFileResponse>('/v1/uploads/qiniu/file', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  })
}

export const getPrivateFileUrlApi = (key: string) =>
  request.get<QiniuUploadFileResponse, QiniuUploadFileResponse>('/v1/uploads/qiniu/url', {
    params: { key },
  })

export const fetchRemoteImageToQiniuApi = (url: string) =>
  request.post<QiniuUploadFileResponse, QiniuUploadFileResponse>('/v1/uploads/qiniu/fetch-url', { url })

// 将指定图片 URL 设为素材的生效主图。
export const setMaterialActiveUrlApi = (materialId: number, url: string) =>
  request.patch<{ url: string }, { url: string }>(`/v1/projects/materials/${materialId}/url`, { url })

// ─────────────────────────────────────────
//  Fragment（片段）相关类型与 API
// ─────────────────────────────────────────

/** 片段状态：0-待生成, 1-生成中, 2-已生成, 3-失败 */
export type FragmentStatus = 0 | 1 | 2 | 3

/** 片段参考类型：0-多参, 1-首帧, 2-首尾帧 */
export type FragmentReferenceType = 0 | 1 | 2

export interface FragmentRecord {
  id: number
  name: string
  description: string
  prompt: string
  reference_type: FragmentReferenceType
  ai_model: string
  style_name: string
  template_prompt: string
  aspect_ratio: string
  resolution: string
  motion_scale: string
  duration_seconds: number
  output_url: string
  status: FragmentStatus
  error_message: string
  project_id: number
  storyboard_id: number
  materials?: MaterialRecord[]
  items?: FragmentItemRecord[]
  /** 后端聚合：已成功生成的视频数量 */
  generated_video_count: number
  /** 后端聚合：正在处理中的任务数量 */
  pending_item_count: number
  /** 后端聚合：正在处理中的任务 ID 列表，用于恢复轮询 */
  pending_item_ids?: number[]
  created_at: string
  updated_at: string
}

export interface CreateFragmentRequest {
  name: string
  description?: string
  prompt?: string
  reference_type?: FragmentReferenceType
  ai_model?: string
  style_name?: string
  template_prompt?: string
  aspect_ratio?: string
  resolution?: string
  motion_scale?: string
  duration_seconds?: number
  storyboard_id?: number
}

export interface UpdateFragmentRequest {
  name?: string
  description?: string
  prompt?: string
  reference_type?: FragmentReferenceType
  ai_model?: string
  style_name?: string
  template_prompt?: string
  aspect_ratio?: string
  resolution?: string
  motion_scale?: string
  duration_seconds?: number
  output_url?: string
  status?: FragmentStatus
  storyboard_id?: number
}

// 获取项目的片段列表，可根据分集 ID 过滤。
export const getFragmentListApi = (projectId: number, storyboardId?: number) =>
  request.get<FragmentRecord[], FragmentRecord[]>(`/v1/projects/${projectId}/fragments`, {
    params: storyboardId ? { storyboard_id: storyboardId } : undefined,
  })

// 在项目下创建新片段。
export const createFragmentApi = (projectId: number, payload: CreateFragmentRequest) =>
  request.post<FragmentRecord, FragmentRecord>(`/v1/projects/${projectId}/fragments`, payload)

// 更新已有片段的属性。
export const updateFragmentApi = (projectId: number, fragmentId: number, payload: UpdateFragmentRequest) =>
  request.patch<{ id: number }, { id: number }>(`/v1/projects/${projectId}/fragments/${fragmentId}`, payload)

// 删除指定片段。
export const deleteFragmentApi = (projectId: number, fragmentId: number) =>
  request.delete<{ id: number }, { id: number }>(`/v1/projects/${projectId}/fragments/${fragmentId}`)

// 按需获取片段关联素材列表（含 material_items 图片记录）。
export const getFragmentMaterialsApi = (projectId: number, fragmentId: number) =>
  request.get<MaterialRecord[], MaterialRecord[]>(
    `/v1/projects/${projectId}/fragments/${fragmentId}/materials`,
    { timeout: 60000 },
  )

// ─────────────────────────────────────────
//  视频生成 / 分镜图生成相关类型与 API
// ─────────────────────────────────────────

/** 片段生成记录类型：0-视频 1-分镜图 */
export type FragmentItemKind = 0 | 1

/** 片段生成记录（视频或分镜图，对应后端 FragmentItem）。 */
export interface FragmentItemRecord {
  id: number
  fragment_id: number
  project_id: number
  kind: FragmentItemKind     // 0-视频 1-分镜图
  ai_model: string
  prompt: string
  size: string
  duration_seconds: number
  style: string
  input_reference: string
  output_images: string      // JSON 图片 URL 数组（分镜图时使用）
  status: FragmentStatus     // 0-待生成 1-生成中 2-已生成 3-失败
  output_url: string
  error_message: string
  upstream_task_id: string
  created_at: string
  updated_at: string
}

/** 提交视频生成任务的请求参数。 */
export interface SubmitVideoGenerationRequest {
  ai_model: string          // 模型名：sora-2 / sora-2-pro / grok-imagine-video 等
  prompt: string            // 提示词
  size: string              // 视频尺寸，如 1280x720 / 720x1280
  seconds?: string          // 时长：按模型可选秒数
  input_reference?: string  // 参考图 URL 或 base64（有值才传，否则上游报错）
  storyboard_reference?: string // 分镜图 URL 或 base64（分开传图模式时使用）
  style?: string            // 视频风格：comic / anime / nostalgic 等
}

/** 提交分镜图生成任务的请求参数。 */
export interface SubmitFragmentImageRequest {
  model: string             // 图片生成模型
  mode: string              // text_to_image | image_to_image
  prompt: string            // 提示词
  size: string              // 图片尺寸，如 1280x720
  count: number             // 生成数量（1-2）
  inputs: { role: string; url: string }[]  // image_to_image 时的输入图
}

/**
 * 为指定片段提交视频生成任务，返回 FragmentItem 记录。
 * POST /api/v1/projects/:projectId/fragments/:fragmentId/video-generation
 */
export const submitVideoGenerationApi = (
  projectId: number,
  fragmentId: number,
  payload: SubmitVideoGenerationRequest,
) =>
  request.post<FragmentItemRecord, FragmentItemRecord>(
    `/v1/projects/${projectId}/fragments/${fragmentId}/video-generation`,
    payload,
    { timeout: 120000 },
  )

/**
 * 为指定片段提交分镜图生成任务，返回 FragmentItem 列表。
 * POST /api/v1/projects/:projectId/fragments/:fragmentId/image-generation
 */
export const submitFragmentImageGenerationApi = (
  projectId: number,
  fragmentId: number,
  payload: SubmitFragmentImageRequest,
) =>
  request.post<{ items: FragmentItemRecord[] }, { items: FragmentItemRecord[] }>(
    `/v1/projects/${projectId}/fragments/${fragmentId}/image-generation`,
    payload,
  )

/**
 * 获取片段下的所有生成记录（降序）。
 * GET /api/v1/projects/:projectId/fragments/:fragmentId/items
 */
export const getFragmentItemsApi = (projectId: number, fragmentId: number) =>
  request.get<FragmentItemRecord[], FragmentItemRecord[]>(
    `/v1/projects/${projectId}/fragments/${fragmentId}/items`,
  )

/**
 * 按 ID 列表批量查询 FragmentItem 状态（轮询用）。
 * GET /api/v1/projects/fragment-item-tasks?ids=1,2,3
 */
export const getFragmentItemTasksApi = (taskIds: number[]) =>
  request.get<FragmentItemRecord[], FragmentItemRecord[]>(
    '/v1/projects/fragment-item-tasks',
    { params: { ids: taskIds.join(',') } },
  )
