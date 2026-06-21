import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import router from './router'
import { createPinia } from 'pinia'

import PrimeVue from 'primevue/config'
import Lara from '@primevue/themes/lara'
import { definePreset } from '@primevue/themes'
import 'primeicons/primeicons.css'

// Componentes PrimeVue de uso global (evita re-importar en cada vista)
import Button from 'primevue/button'
import Card from 'primevue/card'
import Tag from 'primevue/tag'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import Avatar from 'primevue/avatar'
import Divider from 'primevue/divider'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import MultiSelect from 'primevue/multiselect'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import Timeline from 'primevue/timeline'
import SelectButton from 'primevue/selectbutton'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'

// Preset Lara con la identidad visual de APTS: primario índigo + superficies slate.
const AptsTheme = definePreset(Lara, {
  semantic: {
    primary: {
      50: '#eef2ff',
      100: '#e0e7ff',
      200: '#c7d2fe',
      300: '#a5b4fc',
      400: '#818cf8',
      500: '#6366f1',
      600: '#4f46e5',
      700: '#4338ca',
      800: '#3730a3',
      900: '#312e81',
      950: '#1e1b4b'
    },
    colorScheme: {
      light: {
        surface: {
          0: '#ffffff',
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
          950: '#020617'
        }
      },
      dark: {
        surface: {
          0: '#ffffff',
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
          950: '#020617'
        }
      }
    }
  }
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(PrimeVue, {
  theme: {
    preset: AptsTheme,
    options: {
      darkModeSelector: '.dark',
      // El nombre 'primevue' y el orden dejan que las utilidades de Tailwind
      // ganen sobre los estilos de los componentes cuando hace falta.
      cssLayer: {
        name: 'primevue',
        order: 'theme, base, primevue, components, utilities'
      }
    }
  }
})

app.component('Button', Button)
app.component('Card', Card)
app.component('Tag', Tag)
app.component('InputText', InputText)
app.component('Textarea', Textarea)
app.component('Select', Select)
app.component('Message', Message)
app.component('ProgressSpinner', ProgressSpinner)
app.component('Avatar', Avatar)
app.component('Divider', Divider)
app.component('DataTable', DataTable)
app.component('Column', Column)
app.component('MultiSelect', MultiSelect)
app.component('Dialog', Dialog)
app.component('InputNumber', InputNumber)
app.component('Timeline', Timeline)
app.component('SelectButton', SelectButton)
app.component('IconField', IconField)
app.component('InputIcon', InputIcon)

app.mount('#app')
