<template>
  <div class="min-h-screen flex items-center justify-center bg-[#0a0a0a] relative overflow-hidden font-sans">
    <!-- Dynamic background elements -->
    <div class="absolute -top-[20%] -left-[10%] w-[50%] h-[50%] rounded-full bg-blue-900/20 blur-[120px] pointer-events-none"></div>
    <div class="absolute -bottom-[20%] -right-[10%] w-[50%] h-[50%] rounded-full bg-indigo-900/20 blur-[120px] pointer-events-none"></div>
    
    <div class="relative z-10 w-full max-w-md p-10 bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl transition-all duration-500 hover:shadow-blue-900/20 hover:border-white/20">
      
      <!-- Logo / Icon representation -->
      <div class="flex justify-center mb-8">
        <div class="w-16 h-16 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/30">
          <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
          </svg>
        </div>
      </div>

      <h2 class="text-3xl font-extrabold text-center text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400 mb-2 tracking-tight">Portal APTS</h2>
      <p class="text-center text-gray-400 text-sm mb-8">Ingresa tus credenciales para acceder al panel de agentes</p>
      
      <form @submit.prevent="handleLogin" class="space-y-6">
        <div class="space-y-2">
          <label for="password" class="block text-xs font-semibold text-gray-400 uppercase tracking-wider ml-1">Contraseña Maestra</label>
          <div class="relative group">
            <div class="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-gray-400 group-focus-within:text-blue-400 transition-colors">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>
              </svg>
            </div>
            <input 
              id="password"
              v-model="password" 
              type="password" 
              placeholder="••••••••••••"
              class="block w-full pl-11 pr-4 py-3 bg-gray-900/50 border border-gray-700/50 rounded-xl text-white placeholder-gray-500 focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all duration-300 outline-none"
              required
            />
          </div>
        </div>
        
        <button 
          type="submit" 
          :disabled="isLoggingIn"
          class="relative w-full flex justify-center items-center py-3 px-4 border border-transparent rounded-xl shadow-lg text-sm font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 focus:ring-blue-500 transition-all duration-300 disabled:opacity-70 disabled:cursor-not-allowed hover:shadow-blue-500/25 hover:-translate-y-0.5 active:translate-y-0"
        >
          <span v-if="isLoggingIn" class="flex items-center space-x-2">
            <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span>Autenticando...</span>
          </span>
          <span v-else class="tracking-wide">Acceder al Panel</span>
        </button>
        
        <!-- Error message transition -->
        <transition 
          enter-active-class="transition ease-out duration-300" 
          enter-from-class="opacity-0 translate-y-[-10px]" 
          enter-to-class="opacity-100 translate-y-0"
          leave-active-class="transition ease-in duration-200"
          leave-from-class="opacity-100 translate-y-0"
          leave-to-class="opacity-0 translate-y-[-10px]"
        >
          <div v-if="errorMsg" class="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-center">
            <p class="text-sm font-medium text-red-400">{{ errorMsg }}</p>
          </div>
        </transition>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'

const password = ref('')
const router = useRouter()
const errorMsg = ref('')
const isLoggingIn = ref(false)

const handleLogin = async () => {
  errorMsg.value = ''
  isLoggingIn.value = true
  try {
    const res = await fetch('http://localhost:46100/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
      credentials: 'include'
    })
    
    if (res.ok) {
      router.push('/dashboard/overview')
    } else {
      errorMsg.value = 'Contraseña inválida'
    }
  } catch (err) {
    errorMsg.value = 'Error al conectar con el servidor'
  } finally {
    isLoggingIn.value = false
  }
}
</script>
