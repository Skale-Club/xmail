import React from 'react'
import ReactQuill from 'react-quill-new'
import 'react-quill-new/dist/quill.snow.css'

interface RichTextEditorProps {
    value: string
    /** `source` is Quill's change source: 'user' for typing, 'api' for programmatic updates. */
    onChange: (value: string, source?: string) => void
    placeholder?: string
    className?: string
    minHeight?: number
    onFocus?: () => void
    onBlur?: () => void
}

const modules = {
    toolbar: [
        ['bold', 'italic', 'underline', 'strike', 'blockquote'],
        [{ header: [1, 2, 3, false] }],
        [{ list: 'ordered' }, { list: 'bullet' }, { indent: '-1' }, { indent: '+1' }],
        [{ align: [] }],
        [{ color: [] }, { background: [] }],
        ['link', 'image'],
        ['clean']
    ]
}

const formats = [
    'header',
    'bold', 'italic', 'underline', 'strike', 'blockquote',
    'color', 'background',
    'list', 'indent',
    'align',
    'link', 'image'
]

export function RichTextEditor({
    value,
    onChange,
    placeholder = 'Write your message...',
    className = '',
    minHeight = 300,
    onFocus,
    onBlur
}: RichTextEditorProps) {
    const quillRef = React.useRef<ReactQuill>(null)

    return (
        <div className={`compose-editor ${className}`}>
            <ReactQuill
                ref={quillRef}
                theme="snow"
                value={value}
                onChange={(value, _delta, source) => onChange(value, source)}
                modules={modules}
                formats={formats}
                placeholder={placeholder}
                onFocus={onFocus}
                onBlur={onBlur}
                style={{ minHeight: `${minHeight}px` }}
            />
        </div>
    )
}

export function stripHtml(html: string): string {
    const tmp = document.createElement('div')
    tmp.innerHTML = html
    return tmp.textContent || tmp.innerText || ''
}

export function htmlToPlainText(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<li>/gi, '- ')
        .replace(/<\/li>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim()
}
