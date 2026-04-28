<template>
  <div class="min-h-screen bg-gray-900 text-white flex relative">
    <div
      v-if="isMobileMenuOpen"
      class="fixed inset-0 bg-black/50 z-30 lg:hidden"
      @click="closeMobileMenu"
    ></div>

    <aside
      class="fixed inset-y-0 left-0 z-40 lg:static bg-gray-800 border-r border-gray-700 flex flex-col transition-all duration-300 transform lg:translate-x-0"
      :class="[
        isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full',
        isSidebarCollapsed ? 'w-64 lg:w-20' : 'w-64'
      ]"
    >
      <div
        class="p-4 border-b border-gray-700 flex items-center"
        :class="isSidebarCollapsed ? 'justify-center lg:justify-between' : 'justify-between'"
      >
        <h1 v-if="!isSidebarCollapsed" class="text-xl font-bold text-blue-400">Panel APTS</h1>
        <span v-else class="hidden lg:block text-xl font-bold text-blue-400">AP</span>

        <button
          class="h-9 w-9 rounded-md border border-gray-600 hover:bg-gray-700 transition-colors flex items-center justify-center"
          type="button"
          @click="toggleSidebar"
          :aria-label="isSidebarCollapsed ? 'Expandir barra lateral' : 'Colapsar barra lateral'"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-4 w-4 transition-transform"
            :class="isSidebarCollapsed ? 'rotate-180' : ''"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
      </div>

      <nav class="flex-1 p-4 space-y-2">
        <router-link
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="block rounded text-white font-medium hover:bg-gray-600 transition-colors"
          :class="[
            isActive(item.match) ? 'bg-gray-700' : '',
            isSidebarCollapsed ? 'px-2 py-2.5 lg:text-center' : 'px-4 py-2'
          ]"
          :title="item.label"
          @click="closeMobileMenu"
        >
          <span class="flex items-center gap-3" :class="isSidebarCollapsed ? 'justify-center' : ''">
            <span aria-hidden="true" class="text-lg leading-none">{{ item.icon }}</span>
            <span v-if="!isSidebarCollapsed" class="truncate">{{ item.label }}</span>
          </span>
        </router-link>
      </nav>
    </aside>

    <div class="flex-1 min-w-0 flex flex-col lg:ml-0">
      <header class="h-14 border-b border-gray-700 bg-gray-900/80 backdrop-blur px-4 flex items-center lg:hidden">
        <button
          class="h-9 w-9 rounded-md border border-gray-600 hover:bg-gray-700 transition-colors flex items-center justify-center"
          type="button"
          @click="toggleMobileMenu"
          aria-label="Abrir barra lateral"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-5 w-5"
          >
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
      </header>

      <main class="flex-1 p-5 lg:p-8 overflow-y-auto">
        <router-view></router-view>
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

const isSidebarCollapsed = ref(false)
const isMobileMenuOpen = ref(false)

const navItems = [
  { to: '/dashboard/overview', label: 'Resumen', icon: '◧', match: '/dashboard/overview' },
  { to: '/dashboard/projects', label: 'Proyectos', icon: '▦', match: '/dashboard/projects' },
  { to: '/dashboard/settings', label: 'Configuración', icon: '⚙', match: '/dashboard/settings' }
]

const isActive = (pathPrefix) => route.path.startsWith(pathPrefix)

const toggleSidebar = () => {
  if (window.matchMedia('(max-width: 1023px)').matches) {
    isMobileMenuOpen.value = !isMobileMenuOpen.value
    return
  }

  isSidebarCollapsed.value = !isSidebarCollapsed.value
}

const toggleMobileMenu = () => {
  isMobileMenuOpen.value = !isMobileMenuOpen.value
}

const closeMobileMenu = () => {
  isMobileMenuOpen.value = false
}
</script>
