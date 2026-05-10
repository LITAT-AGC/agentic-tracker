import router from '../router'

const rawBaseUrl = import.meta.env.VITE_API_BASE_URL || '/api'

const normalizedBaseUrl = rawBaseUrl.endsWith('/')
  ? rawBaseUrl.slice(0, -1)
  : rawBaseUrl

let isRedirectingToLogin = false

export const apiUrl = (path) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${normalizedBaseUrl}${normalizedPath}`
}

export const apiFetch = async (path, options = {}) => {
  const {
    skipUnauthorizedRedirect = false,
    ...fetchOptions
  } = options

  const response = await fetch(apiUrl(path), fetchOptions)

  if (response.status === 401 && !skipUnauthorizedRedirect) {
    const currentRoute = router.currentRoute.value

    if (!isRedirectingToLogin && currentRoute.path !== '/login') {
      isRedirectingToLogin = true

      await router.replace({
        path: '/login',
        query: currentRoute.fullPath ? { redirect: currentRoute.fullPath } : undefined
      })

      isRedirectingToLogin = false
    }
  }

  return response
}

export const readApiResponse = async (response) => {
  const rawText = await response.text()

  if (!rawText) {
    return null
  }

  try {
    return JSON.parse(rawText)
  } catch (_error) {
    return {
      error: rawText.trim() || null
    }
  }
}

export const apiFetchJson = async (path, options = {}, fallbackMessage = 'La solicitud no se pudo completar.') => {
  const response = await apiFetch(path, options)
  const data = await readApiResponse(response)

  if (!response.ok) {
    const apiMessage = typeof data?.error === 'string' && data.error.trim()
      ? data.error.trim()
      : fallbackMessage
    const error = new Error(apiMessage)
    error.status = response.status
    error.data = data
    throw error
  }

  return { response, data }
}

export const getApiErrorMessage = (error, fallbackMessage = 'La operación no se pudo completar.') => {
  if (error?.status === 401) {
    return 'Tu sesión expiró o no estás autenticado.'
  }

  if (error?.status === 503) {
    return error.message || 'El servicio externo está temporalmente no disponible.'
  }

  if (error instanceof TypeError) {
    return 'No se pudo conectar con el servidor.'
  }

  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message.trim()
  }

  return fallbackMessage
}
