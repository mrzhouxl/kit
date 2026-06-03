<script setup lang="ts">
import { computed, type Component } from 'vue'

const props = withDefaults(defineProps<{
  icon: Component
  size?: number | string
  strokeWidth?: number
  color?: string
  background?: string
  spin?: boolean
}>(), {
  size: 16,
  strokeWidth: 2,
  color: 'currentColor',
  background: 'transparent',
  spin: false,
})

const iconFill = computed(() => [props.color, props.background, props.color, props.background])
</script>

<template>
  <component
    :is="icon"
    theme="outline"
    :size="size"
    :stroke-width="strokeWidth"
    :fill="iconFill"
    :spin="spin"
  />
</template>
