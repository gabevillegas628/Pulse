import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProfessorAuthProvider } from '@/context/ProfessorAuthContext'
import { StudentAuthProvider } from '@/context/StudentAuthContext'
import { startTokenWatchdog } from '@/lib/tokenWatchdog'
import App from './App'
import './styles/globals.css'
import 'ketcher-react/dist/index.css'

// Before React mounts, so a token that disappears during startup is still witnessed.
startTokenWatchdog()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <ProfessorAuthProvider>
          <StudentAuthProvider>
            <App />
          </StudentAuthProvider>
        </ProfessorAuthProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>
)
