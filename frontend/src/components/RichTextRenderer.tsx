import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import DOMPurify from 'dompurify'

interface Props {
  content: string
}

function isJson(s: string): boolean {
  try {
    const v = JSON.parse(s)
    return typeof v === 'object' && v !== null
  } catch {
    return false
  }
}

export default function RichTextRenderer({ content }: Props) {
  const isRich = isJson(content)

  const editor = useEditor(
    {
      extensions: [StarterKit, Image, Subscript, Superscript],
      content: isRich ? JSON.parse(content) : content,
      editable: false,
    },
    [content]
  )

  if (!isRich) {
    return (
      <p
        className="text-gray-900"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content) }}
      />
    )
  }

  return (
    <div className="prose prose-sm max-w-none text-gray-900 [&_.tiptap]:outline-none">
      <EditorContent editor={editor} />
    </div>
  )
}
