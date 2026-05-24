import { useRef, useEffect } from 'react'

interface Props {
  smiles: string
  width?: number
  height?: number
}

/** Renders a SMILES chemical structure as an SVG using smiles-drawer. */
export default function SmilesRenderer({ smiles, width = 260, height = 160 }: Props) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (!ref.current || !smiles) return
    import('smiles-drawer').then((mod) => {
      const SD = mod.default ?? mod
      const drawer = new SD.SmiDrawer({ width, height })
      drawer.draw(smiles, ref.current, 'light', null, null)
    }).catch(() => { /* invalid SMILES — leave blank */ })
  }, [smiles, width, height])
  return <svg ref={ref} width={width} height={height} className="block" />
}
