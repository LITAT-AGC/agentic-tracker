<template>
  <div class="min-h-screen bg-surface-50 text-surface-900 flex relative">
    <div
      v-if="isMobileMenuOpen"
      class="fixed inset-0 bg-black/50 z-30 lg:hidden"
      @click="closeMobileMenu"
    ></div>

    <aside
      class="fixed inset-y-0 left-0 z-40 lg:static bg-surface-0 border-r border-surface-200 flex flex-col transition-all duration-300 transform lg:translate-x-0"
      :class="[
        isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full',
        isSidebarCollapsed ? 'w-64 lg:w-20' : 'w-64'
      ]"
    >
      <div
        class="p-4 border-b border-surface-200 flex items-center"
        :class="isSidebarCollapsed ? 'justify-center lg:justify-between' : 'justify-between'"
      >
        <h1 v-if="!isSidebarCollapsed" class="text-xl font-bold text-primary-600">Panel APTS</h1>
        <span v-else class="hidden lg:block text-xl font-bold text-primary-600">AP</span>

        <Button
          :icon="isSidebarCollapsed ? 'pi pi-angle-right' : 'pi pi-angle-left'"
          severity="secondary"
          text
          rounded
          size="small"
          @click="toggleSidebar"
          :aria-label="isSidebarCollapsed ? 'Expandir barra lateral' : 'Colapsar barra lateral'"
        />
      </div>

      <nav class="flex-1 p-4 space-y-2">
        <router-link
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="block rounded-lg font-medium transition-colors"
          :class="[
            isActive(item.match)
              ? 'bg-primary/15 text-primary-600'
              : 'text-surface-600 hover:bg-surface-200',
            isSidebarCollapsed ? 'px-2 py-2.5 lg:text-center' : 'px-4 py-2.5'
          ]"
          :title="item.label"
          @click="closeMobileMenu"
        >
          <span class="flex items-center gap-3" :class="isSidebarCollapsed ? 'justify-center' : ''">
            <i :class="item.icon" class="text-base leading-none"></i>
            <span v-if="!isSidebarCollapsed" class="truncate">{{ item.label }}</span>
          </span>
        </router-link>
      </nav>
    </aside>

    <div class="flex-1 min-w-0 flex flex-col lg:ml-0">
      <header class="h-14 border-b border-surface-200 bg-surface-0/80 backdrop-blur px-4 flex items-center lg:hidden">
        <Button
          icon="pi pi-bars"
          severity="secondary"
          text
          @click="toggleMobileMenu"
          aria-label="Abrir barra lateral"
        />
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
  { to: '/dashboard/overview', label: 'Resumen', icon: 'pi pi-th-large', match: '/dashboard/overview' },
  { to: '/dashboard/projects', label: 'Proyectos', icon: 'pi pi-folder', match: '/dashboard/projects' },
  { to: '/dashboard/settings', label: 'Configuración', icon: 'pi pi-cog', match: '/dashboard/settings' }
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
