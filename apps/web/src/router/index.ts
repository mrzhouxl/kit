import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      component: () => import('@/layouts/MainLayout.vue'),
      children: [
        {
          path: '',
          redirect: '/agent',
        },
        {
          path: 'agent',
          name: 'Agent',
          component: () => import('@/views/agent/AgentView.vue'),
        },
        {
          path: 'settings',
          name: 'Settings',
          component: () => import('@/views/settings/SettingsView.vue'),
        },
      ],
    },
  ],
})

export default router
