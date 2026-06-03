---
name: pdf-maker
description: 使用 reportlab 生成结构化 PDF（封面、正文、多段落），适合从零生成文档。
version: 1.0.0
---

# pdf-maker

用于从零生成 PDF 文档，不依赖已有 PDF。

## 适用场景

- 生成汇报文档、说明书、简报、方案文档
- 根据标题和正文内容输出 PDF 文件
- 需要中文内容展示（默认使用 CID 字体，兼容中文）

## 运行前提

- 自动安装 `requirements.txt` 中的依赖
- 通过 `execute_skill(action="run")` 执行脚本

## 可用脚本

- `scripts/make_pdf.py`

## 脚本参数

- `--title` 文档标题
- `--body` 正文内容（可包含换行）
- `--output` 输出路径（默认 `/home/sandbox/output.pdf`）

## 示例

```bash
python scripts/make_pdf.py \
  --title "项目周报" \
  --body "一、进展\n- 完成登录接口\n\n二、风险\n- 需要优化稳定性" \
  --output /home/sandbox/项目周报.pdf
```

## 说明

- 本 skill 专注“生成 PDF”。
- 对“修改已有 PDF”场景，优先使用 `nano-pdf`。
