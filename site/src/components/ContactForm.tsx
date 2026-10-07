import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, Send } from 'lucide-react'
import { useState } from 'react'

const SUBJECTS = [
  'Starlink Kit Inquiry',
  'Computing & Servers',
  'Networking & Infrastructure',
  'Surveillance & Security',
  'IT Services & Support',
  'Website & Web Development',
  'Mobile App Development',
  'Custom Software Engineering',
  'Other',
]

type FieldErrors = {
  name?: string
  email?: string
  subject?: string
  message?: string
}

export function ContactForm() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle')

  const validate = (): boolean => {
    const next: FieldErrors = {}
    if (!name.trim()) next.name = 'Please enter your name'
    if (!email.trim() || !/^\S+@\S+\.\S+$/.test(email)) next.email = 'Please enter a valid email'
    if (!subject) next.subject = 'Please select a subject'
    if (!message.trim()) next.message = 'Please enter your message'
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate() || status === 'sending') return
    setStatus('sending')
    window.setTimeout(() => {
      setStatus('sent')
      setName('')
      setEmail('')
      setSubject('')
      setMessage('')
      window.setTimeout(() => setStatus('idle'), 6000)
    }, 1200)
  }

  const errorText = (field: keyof FieldErrors) =>
    errors[field] ? <span className="mt-1 block text-xs font-semibold text-rose-400">{errors[field]}</span> : null

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="formName" className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-300">
            Your Name
          </label>
          <input
            id="formName"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="John Doe"
            className="input-surface"
          />
          {errorText('name')}
        </div>
        <div>
          <label htmlFor="formEmail" className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-300">
            Email Address
          </label>
          <input
            id="formEmail"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="john@example.com"
            className="input-surface"
          />
          {errorText('email')}
        </div>
      </div>

      <div>
        <label htmlFor="formSubject" className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-300">
          Subject
        </label>
        <select
          id="formSubject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="input-surface appearance-none"
        >
          <option value="" className="bg-panel">
            Select a topic...
          </option>
          {SUBJECTS.map((s) => (
            <option key={s} value={s} className="bg-panel">
              {s}
            </option>
          ))}
        </select>
        {errorText('subject')}
      </div>

      <div>
        <label htmlFor="formMessage" className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-300">
          Message
        </label>
        <textarea
          id="formMessage"
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Tell us about your project or what you need..."
          className="input-surface resize-none"
        />
        {errorText('message')}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button type="submit" disabled={status === 'sending'} className="btn-primary px-7 py-3.5 text-sm uppercase">
          {status === 'sending' ? (
            <span className="flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              Sending...
            </span>
          ) : (
            <span className="flex items-center gap-2">
              Send Message
              <Send size={15} />
            </span>
          )}
        </button>

        <AnimatePresence>
          {status === 'sent' && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2 text-sm font-semibold text-cyan-300"
            >
              <CheckCircle2 size={18} />
              Thank you! We'll get back to you within 24 hours.
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </form>
  )
}