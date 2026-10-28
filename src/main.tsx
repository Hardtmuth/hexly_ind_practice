import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './i18next.ts'

import './style.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
