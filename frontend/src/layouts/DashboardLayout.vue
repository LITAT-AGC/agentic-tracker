<template>
  <div class="min-h-screen bg-gray-900 text-white flex">
    <!-- Sidebar -->
    <aside class="w-64 bg-gray-800 border-r border-gray-700 flex flex-col">
      <div class="p-4 border-b border-gray-700">
        <h1 class="text-xl font-bold text-blue-400">Panel APTS</h1>
      </div>
      <nav class="flex-1 p-4 space-y-2">
        <router-link to="/dashboard/overview" class="block px-4 py-2 rounded text-white font-medium hover:bg-gray-600" active-class="bg-gray-700">
          Resumen
        </router-link>
        <router-link to="/dashboard/projects" class="block px-4 py-2 rounded text-white font-medium hover:bg-gray-600" active-class="bg-gray-700">
          Proyectos
        </router-link>
        <router-link to="/dashboard/settings" class="block px-4 py-2 rounded text-white font-medium hover:bg-gray-600" active-class="bg-gray-700">
          Configuración
        </router-link>
      </nav>
    </aside>

    <!-- Main Content -->
    <main class="flex-1 p-8 overflow-y-auto">
      <router-view></router-view>
    </main>
  </div>
</template>

<script setup>
</script>
