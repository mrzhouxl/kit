<script setup lang="ts">
import MarkdownIt from 'markdown-it'

const props = defineProps<{
  content: string
}>()

/* Markdown 渲染器 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

/** 渲染 Markdown */
function render() {
  return md.render(props.content || '')
}
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="markdown-body" v-html="render()" />
</template>
