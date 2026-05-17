import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import { Bold, Italic, List, Subscript as SubscriptIcon, Superscript as SuperscriptIcon, ImageIcon } from 'lucide-react'
import { useRef } from 'react'
import { api } from '@/api/client'

interface Props {
  content: string
  onChange: (json: string) => void
}

export default function RichTextEditor({ content, onChange }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const editor = useEditor({
    extensions: [StarterKit, Image, Subscript, Superscript],
    content: (() => {
      try { return JSON.parse(content) } catch { return content }
    })(),
    onUpdate: ({ editor }) => {
      onChange(JSON.stringify(editor.getJSON()))
    },
    editorProps: {
      attributes: {
        class: 'min-h-[100px] outline-none p-3 text-sm text-gray-900',
      },
    },
  })

  async function handleImageUpload(file: File) {
    const form = new FormData()
    form.append('image', file)
    try {
      const { data } = await api.post<{ url: string }>('/uploads/image', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      editor?.chain().focus().setImage({ src: data.url }).run()
    } catch {
      alert('Image upload failed. Check file type and size (max 5 MB).')
    }
  }

  if (!editor) return null

  const btn = 'p-1.5 rounded hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed'
  const active = 'bg-gray-200'

  return (
    <div className="border border-gray-300 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-gray-200 bg-gray-50">
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`${btn} ${editor.isActive('bold') ? active : ''}`}
          title="Bold"
        >
          <Bold size={15} />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={`${btn} ${editor.isActive('italic') ? active : ''}`}
          title="Italic"
        >
          <Italic size={15} />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleSubscript().run()}
          className={`${btn} ${editor.isActive('subscript') ? active : ''}`}
          title="Subscript"
        >
          <SubscriptIcon size={15} />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleSuperscript().run()}
          className={`${btn} ${editor.isActive('superscript') ? active : ''}`}
          title="Superscript"
        >
          <SuperscriptIcon size={15} />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={`${btn} ${editor.isActive('bulletList') ? active : ''}`}
          title="Bullet list"
        >
          <List size={15} />
        </button>
        <div className="w-px h-5 bg-gray-300 mx-1" />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className={btn}
          title="Insert image"
        >
          <ImageIcon size={15} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleImageUpload(file)
            e.target.value = ''
          }}
        />
      </div>

      <EditorContent editor={editor} />
    </div>
  )
}
