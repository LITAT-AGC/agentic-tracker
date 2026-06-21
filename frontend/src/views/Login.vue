<template>
  <div class="min-h-screen flex items-center justify-center bg-surface-50 relative overflow-hidden font-sans p-4">
    <!-- Fondo dinámico -->
    <div class="absolute -top-[20%] -left-[10%] w-[50%] h-[50%] rounded-full bg-primary-900/20 blur-[120px] pointer-events-none"></div>
    <div class="absolute -bottom-[20%] -right-[10%] w-[50%] h-[50%] rounded-full bg-primary-700/20 blur-[120px] pointer-events-none"></div>

    <Card class="relative z-10 w-full max-w-md animate-fade-in" :pt="{ body: { class: 'p-8' } }">
      <template #header>
        <div class="flex justify-center pt-8">
          <Avatar icon="pi pi-shield" size="xlarge" shape="circle"
            :pt="{ root: { class: 'bg-primary text-primary-contrast shadow-lg shadow-primary/30' } }" />
        </div>
      </template>

      <template #title>
        <h2 class="text-2xl font-extrabold text-center tracking-tight">Portal APTS</h2>
      </template>

      <template #subtitle>
        <p class="text-center text-surface-500 text-sm">Ingresa tus credenciales para acceder al panel de agentes</p>
      </template>

      <template #content>
        <form @submit.prevent="handleLogin" class="space-y-6 mt-4">
          <div class="space-y-2">
            <label for="password" class="block text-xs font-semibold text-surface-500 uppercase tracking-wider">Contraseña Maestra</label>
            <IconField>
              <InputIcon class="pi pi-lock" />
              <InputText
                id="password"
                v-model="password"
                type="password"
                placeholder="••••••••••••"
                class="w-full"
                required
              />
            </IconField>
          </div>

          <Button
            type="submit"
            :loading="isLoggingIn"
            :label="isLoggingIn ? 'Autenticando...' : 'Acceder al Panel'"
            icon="pi pi-sign-in"
            class="w-full"
          />

          <Message v-if="errorMsg" severity="error" :closable="false" class="animate-fade-in">
            {{ errorMsg }}
          </Message>
        </form>
      </template>
    </Card>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { apiUrl } from '../config/api'

const password = ref('')
const router = useRouter()
const errorMsg = ref('')
const isLoggingIn = ref(false)

const handleLogin = async () => {
  errorMsg.value = ''
  isLoggingIn.value = true
  try {
    const res = await fetch(apiUrl('/login'), {
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
