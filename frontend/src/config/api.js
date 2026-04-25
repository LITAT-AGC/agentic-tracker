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
