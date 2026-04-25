import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { apiFetch } from '../config/api'

export const useDashboardStore = defineStore('dashboard', () => {
  const projects = ref([])
  const tasks = ref([])
  const feed = ref([])
  const isLoading = ref(false)
  const error = ref(null)

  const activeProjectsCount = computed(() => {
    return projects.value.filter(p => p.status !== 'blocked').length
  })

  const blockedProjectsCount = computed(() => {
    return projects.value.filter(p => p.status === 'blocked').length
  })

  const stalledAgentsCount = computed(() => {
    return tasks.value.filter(t => t.status === 'stalled').length
  })

  const fetchOverview = async () => {
    isLoading.value = true
    error.value = null
    try {
      const response = await apiFetch('/dashboard/overview', {
        credentials: 'include' // Since backend uses express-session with cookies
      })

      if (!response.ok) {
        throw new Error('Failed to fetch dashboard data')
      }

      const data = await response.json()
      projects.value = data.projects || []
      tasks.value = data.tasks || []
      feed.value = data.feed || []
    } catch (err) {
      error.value = err.message
      throw err
    } finally {
      isLoading.value = false
    }
  }

  const resolveBlocker = async (taskId, instruction) => {
    try {
      const response = await apiFetch(`/tasks/${taskId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction }),
        credentials: 'include'
      })
      if (!response.ok) throw new Error('Failed to resolve blocker')

      // Refresh the dashboard immediately
      await fetchOverview()
      return true
    } catch (err) {
      console.error(err)
      throw err
    }
  }

  return {
    projects,
    tasks,
    feed,
    isLoading,
    error,
    activeProjectsCount,
    blockedProjectsCount,
    stalledAgentsCount,
    fetchOverview,
    resolveBlocker
  }
})
