import { useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { jsPDF } from "jspdf"
import {
  Theme,
  Screen,
  Header,
  Title,
  Status,
  ScannerFrame,
  Button,
  IconButton,
  SegmentedControl,
  EmptyState,
  ThumbnailStrip,
} from "@pechat-tut/ui"
import "@pechat-tut/ui/styles.css"
import { useTranslation } from "../i18n/useTranslation"

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    cv: any
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

interface ScannedPage {
  id: string
  src: string
  rotation: number
  type: "scan" | "photo"
}

type ScanFilter = "color" | "grayscale" | "text"

export const ScannerScreen = () => {
  const { t } = useTranslation()

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const [pages, setPages] = useState<ScannedPage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isOpenCvReady, setIsOpenCvReady] = useState<boolean>(false)
  const [hasDocumentInFrame, setHasDocumentInFrame] = useState<boolean>(false)
  const lastPointsRef = useRef<number[] | null>(null)
  const [filter, setFilter] = useState<ScanFilter>("color")
  const [selectedPageId, setSelectedPageId] = useState<string>("")

  const lastPageId = pages.length > 0 ? pages[pages.length - 1].id : ""
  const activePageId = selectedPageId || lastPageId

  const overlay: CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    transform: "scaleX(-1)",
  }

  const videoStyle: CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    transform: "scaleX(-1)",
    objectFit: "fill",
  }

  const overlayStyle: CSSProperties = { ...overlay, width: "100%", height: "100%" }

  // Проверка готовности OpenCV.js
  useEffect(() => {
    const checkOpenCV = () => {
      if (window.cv && window.cv.Mat) {
        setIsOpenCvReady(true)
      } else {
        setTimeout(checkOpenCV, 100)
      }
    }
    checkOpenCV()
  }, [])

  // Камера + отрисовка контура рамки документа
  /* eslint-disable @typescript-eslint/no-explicit-any */
  useEffect(() => {
    let stream: MediaStream | null = null
    let animationFrameId: number
    let cap: any = null
    let src: any = null
    let dst: any = null
    let contours: any = null
    let hierarchy: any = null

    const startCamera = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: "environment",
          },
          audio: false,
        })
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.onloadedmetadata = () => {
            if (isOpenCvReady && videoRef.current) {
              const width = videoRef.current.videoWidth
              const height = videoRef.current.videoHeight
              videoRef.current.width = width
              videoRef.current.height = height
              initOpenCVProcessing()
            }
          }
        }
      } catch (err) {
        setError(t("errors.cameraAccessDenied"))
        console.error(err)
      }
    }

    const initOpenCVProcessing = () => {
      const video = videoRef.current
      const overlayCanvas = overlayCanvasRef.current
      if (!video || !overlayCanvas || !window.cv) return

      const cv = window.cv

      overlayCanvas.width = video.width
      overlayCanvas.height = video.height

      cap = new cv.VideoCapture(video)
      src = new cv.Mat(video.height, video.width, cv.CV_8UC4)
      dst = new cv.Mat(video.height, video.width, cv.CV_8UC1)
      contours = new cv.MatVector()
      hierarchy = new cv.Mat()

      const processVideo = () => {
        try {
          console.log(
            "[pui] processVideo: readyState=" +
              videoRef.current?.readyState +
              " paused=" +
              videoRef.current?.paused +
              " video=" +
              videoRef.current?.videoWidth +
              "x" +
              videoRef.current?.videoHeight,
          )
          if (
            !videoRef.current ||
            videoRef.current.paused ||
            videoRef.current.ended
          )
            return

          cap.read(src)
          cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY)

          const ksize = new cv.Size(5, 5)
          cv.GaussianBlur(dst, dst, ksize, 0, 0, cv.BORDER_DEFAULT)

          cv.Canny(dst, dst, 75, 200, 3, false)

          const M = cv.Mat.ones(3, 3, cv.CV_8U)
          cv.dilate(
            dst,
            dst,
            M,
            new cv.Point(-1, -1),
            1,
            cv.BORDER_CONSTANT,
            cv.morphologyDefaultBorderValue(),
          )
          M.delete()

          cv.findContours(
            dst,
            contours,
            hierarchy,
            cv.RETR_LIST,
            cv.CHAIN_APPROX_SIMPLE,
          )

          let maxArea = 0

          let pageContour: any = null
          const frameArea = video.width * video.height

          for (let i = 0; i < contours.size(); ++i) {
            const contour = contours.get(i)
            const area = cv.contourArea(contour)

            if (area > frameArea * 0.1) {
              const peri = cv.arcLength(contour, true)
              const approx = new cv.Mat()

              cv.approxPolyDP(contour, approx, 0.02 * peri, true)

              if (approx.rows === 4 && area > maxArea) {
                maxArea = area
                if (pageContour) pageContour.delete()
                pageContour = approx
              } else {
                approx.delete()
              }
            }
            contour.delete()
          }

          console.log("[pui] frame analysis: contours=" + contours.size() + " maxArea=" + maxArea)

          const ctx = overlayCanvas.getContext("2d", {
            willReadFrequently: true,
          })
          if (ctx) {
            if (overlayCanvas.width > 0 && overlayCanvas.height > 0) {
              const frameData = ctx.getImageData(0, 0, overlayCanvas.width, overlayCanvas.height)
              let sum = 0
              let sumSq = 0
              let count = 0
              for (let i = 0; i < frameData.data.length; i += 4) {
                const v = (frameData.data[i] + frameData.data[i + 1] + frameData.data[i + 2]) / 3
                sum += v
                sumSq += v * v
                count++
              }
              const mean = count > 0 ? sum / count : 0
              const std = count > 0 ? Math.sqrt(Math.max(0, sumSq / count - mean * mean)) : 0
              console.log("[pui] frame stats: mean=" + mean.toFixed(2) + " std=" + std.toFixed(2))
            }
            ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)

            console.log("[pui] hasDocumentInFrame:", !!pageContour)
            if (pageContour) {
              setHasDocumentInFrame(true)
              lastPointsRef.current = Array.from(pageContour.data32S)

              ctx.strokeStyle = "#00FF00"
              ctx.lineWidth = 4
              ctx.beginPath()

              const d = pageContour.data32S
              ctx.moveTo(d[0], d[1])
              ctx.lineTo(d[2], d[3])
              ctx.lineTo(d[4], d[5])
              ctx.lineTo(d[6], d[7])
              ctx.closePath()
              ctx.stroke()
              console.log("[pui] document contour points:", Array.from(pageContour.data32S))

              pageContour.delete()
            } else {
              setHasDocumentInFrame(false)
            }
          }

          animationFrameId = requestAnimationFrame(processVideo)
        } catch (e) {
          console.error(t("errors.opencvFrameProcessing"), e)
        }
      }

      animationFrameId = requestAnimationFrame(processVideo)
    }

    if (isOpenCvReady) {
      startCamera()
    }

    return () => {
      cancelAnimationFrame(animationFrameId)
      if (stream) {
        stream.getTracks().forEach((track) => track.stop())
      }
      if (src) src.delete()
      if (dst) dst.delete()
      if (contours) contours.delete()
      if (hierarchy) hierarchy.delete()
      if (cap) cap.delete()
    }
  }, [t, isOpenCvReady])

  // Применение фильтра к оверлею камеры
  useEffect(() => {
    const canvas = overlayCanvasRef.current
    if (!canvas) return
    canvas.style.filter =
      filter === "grayscale"
        ? "grayscale(1)"
        : filter === "text"
          ? "grayscale(1) contrast(2)"
          : "none"
  }, [filter])

  const takeNormalPhoto = () => {
    const video = videoRef.current
    const canvas = canvasRef.current

    if (video && canvas) {
      const ctx = canvas.getContext("2d", { willReadFrequently: true })
      if (ctx) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight

        ctx.translate(canvas.width, 0)
        ctx.scale(-1, 1)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        ctx.setTransform(1, 0, 0, 1, 0, 0)

        const newPage: ScannedPage = {
          id: Date.now().toString(),
          src: canvas.toDataURL("image/png"),
          rotation: 0,
          type: "photo",
        }
        setPages((prev) => [...prev, newPage])
      }
    }
  }

  const takeCroppedPhoto = () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    const cv = window.cv

    if (!video || !canvas || !cv || !lastPointsRef.current) return

    try {
      const pts = lastPointsRef.current
      const origPoints = [
        { x: pts[0], y: pts[1] },
        { x: pts[2], y: pts[3] },
        { x: pts[4], y: pts[5] },
        { x: pts[6], y: pts[7] },
      ]

      const sortedByX = [...origPoints].sort((a, b) => a.x - b.x)
      const leftMost = [sortedByX[0], sortedByX[1]]
      const rightMost = [sortedByX[2], sortedByX[3]]

      const tl = leftMost[0].y < leftMost[1].y ? leftMost[0] : leftMost[1]
      const bl = leftMost[0].y < leftMost[1].y ? leftMost[1] : leftMost[0]
      const tr = rightMost[0].y < rightMost[1].y ? rightMost[0] : rightMost[1]
      const br = rightMost[0].y < rightMost[1].y ? rightMost[1] : rightMost[0]

      const widthA = Math.hypot(br.x - bl.x, br.y - bl.y)
      const widthB = Math.hypot(tr.x - tl.x, tr.y - tl.y)
      const maxWidth = Math.max(widthA, widthB)

      const heightA = Math.hypot(tr.x - br.x, tr.y - br.y)
      const heightB = Math.hypot(tl.x - br.x, tl.y - br.y)
      const maxHeight = Math.max(heightA, heightB)

      canvas.width = maxWidth
      canvas.height = maxHeight

      const imageSrc = new cv.Mat(
        video.videoHeight,
        video.videoWidth,
        cv.CV_8UC4,
      )
      const imageDst = new cv.Mat(maxHeight, maxWidth, cv.CV_8UC4)

      const tempCap = new cv.VideoCapture(video)
      tempCap.read(imageSrc)

      const srcCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [
        tl.x,
        tl.y,
        tr.x,
        tr.y,
        br.x,
        br.y,
        bl.x,
        bl.y,
      ])
      const dstCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0,
        0,
        maxWidth,
        0,
        maxWidth,
        maxHeight,
        0,
        maxHeight,
      ])

      const dsize = new cv.Size(maxWidth, maxHeight)
      const M = cv.getPerspectiveTransform(srcCoords, dstCoords)

      cv.warpPerspective(
        imageSrc,
        imageDst,
        M,
        dsize,
        cv.INTER_LINEAR,
        cv.BORDER_CONSTANT,
        new cv.Scalar(),
      )
      cv.imshow(canvas, imageDst)

      const ctx = canvas.getContext("2d", { willReadFrequently: true })
      if (ctx) {
        const tempCanvas = document.createElement("canvas")
        tempCanvas.width = canvas.width
        tempCanvas.height = canvas.height
        const tempCtx = tempCanvas.getContext("2d")
        if (tempCtx) {
          tempCtx.drawImage(canvas, 0, 0)
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          ctx.translate(canvas.width, 0)
          ctx.scale(-1, 1)
          ctx.drawImage(tempCanvas, 0, 0)
          ctx.setTransform(1, 0, 0, 1, 0, 0)
        }
      }

      const newPage: ScannedPage = {
        id: Date.now().toString(),
        src: canvas.toDataURL("image/png"),
        rotation: 0,
        type: "scan",
      }
      setPages((prev) => [...prev, newPage])

      imageSrc.delete()
      imageDst.delete()
      srcCoords.delete()
      dstCoords.delete()
      M.delete()
    } catch (e) {
      console.error(t("errors.opencvPerspectiveCorrection"), e)
    }
  }

  /* eslint-enable @typescript-eslint/no-explicit-any */

  const rotatePage = (id: string) => {
    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, rotation: (p.rotation + 90) % 360 } : p)))
  }

  const deletePage = (id: string) => {
    setPages((prev) => prev.filter((p) => p.id !== id))
  }

  const getRenderedPageCanvas = (page: ScannedPage): Promise<HTMLCanvasElement> => {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement("canvas")
        const ctx = canvas.getContext("2d")
        if (!ctx) return resolve(canvas)
        if (page.rotation === 90 || page.rotation === 270) {
          canvas.width = img.height
          canvas.height = img.width
        } else {
          canvas.width = img.width
          canvas.height = img.height
        }
        ctx.translate(canvas.width / 2, canvas.height / 2)
        ctx.rotate((page.rotation * Math.PI) / 180)
        ctx.drawImage(img, -img.width / 2, -img.height / 2)
        resolve(canvas)
      }
      img.src = page.src
    })
  }

  const downloadAll = async () => {
    if (pages.length === 0) return
    if (pages[0].type === "scan") {
      const pdf = new jsPDF("p", "mm", "a4")
      for (let i = 0; i < pages.length; i++) {
        const renderedCanvas = await getRenderedPageCanvas(pages[i])
        const imgData = renderedCanvas.toDataURL("image/jpeg", 1.0)
        if (i > 0) pdf.addPage()
        const pdfWidth = pdf.internal.pageSize.getWidth()
        const pdfHeight = pdf.internal.pageSize.getHeight()
        pdf.addImage(imgData, "JPEG", 0, 0, pdfWidth, pdfHeight)
      }
      pdf.save("scanned-doc.pdf")
    } else {
      for (let i = 0; i < pages.length; i++) {
        const renderedCanvas = await getRenderedPageCanvas(pages[i])
        const link = document.createElement("a")
        link.download = `photo-capture-${i + 1}.png`
        link.href = renderedCanvas.toDataURL("image/png")
        link.click()
      }
    }
  }

  const printPages = async () => {
    if (pages.length === 0) return
    const iframe = document.createElement("iframe")
    iframe.style.position = "fixed"
    iframe.style.right = "0"
    iframe.style.bottom = "0"
    iframe.style.width = "0"
    iframe.style.height = "0"
    iframe.style.border = "none"
    document.body.appendChild(iframe)
    const iframeDoc = iframe.contentWindow?.document
    if (!iframeDoc) return
    const iframeStyle = iframeDoc.createElement("style")
    iframeStyle.textContent = `
      body { margin: 0; display: flex; flex-direction: column; align-items: center; }
      img { max-width: 100%; page-break-after: always; margin-bottom: 20px; }
    `
    iframeDoc.head.appendChild(iframeStyle)
    for (const page of pages) {
      const renderedCanvas = await getRenderedPageCanvas(page)
      const img = iframeDoc.createElement("img")
      img.src = renderedCanvas.toDataURL("image/png")
      iframeDoc.body.appendChild(img)
    }
    iframe.contentWindow?.focus()
    iframe.contentWindow?.print()
    setTimeout(() => {
      document.body.removeChild(iframe)
    }, 1000)
  }

  return (
    <Theme>
      <Screen>
        <Header
          logoSrc="/logo.svg"
          logoAlt="ПЕЧАТЬ.ТУТ"
          onBack={() => console.log("back requested")}
          right={
            <IconButton
              icon="refresh"
              label={t("scannerScreen.refresh")}
              onClick={() => console.log("retry camera requested")}
            />
          }
        />
        <Title subtitle={t("scannerScreen.subtitle")}>
          {t("scannerScreen.title")}
        </Title>
        <ScannerFrame label={t("scannerScreen.frameLabel")}>
          {isOpenCvReady ? (
            <>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="scanner-video"
                style={videoStyle}
              />
              <canvas
                ref={overlayCanvasRef}
                className="scanner-overlay-canvas"
                style={overlayStyle}
              />
            </>
          ) : (
            <EmptyState
              title={t("scannerScreen.cameraNotReadyTitle")}
              description={t("scannerScreen.cameraNotReadyDescription")}
              icon="camera"
            />
          )}
        </ScannerFrame>
        <Status tone={error ? "error" : "info"}>
          {error ?? t("scannerScreen.statusReady")}
        </Status>
        <SegmentedControl
          label={t("scannerScreen.filterLabel")}
          value={filter}
          onChange={(value) => setFilter(value as ScanFilter)}
          options={[
            { value: "color", label: t("scannerScreen.filterColor") },
            { value: "grayscale", label: t("scannerScreen.filterGrayscale") },
            { value: "text", label: t("scannerScreen.filterText") },
          ]}
        />
        {pages.length > 0 && (
          <ThumbnailStrip
            pages={pages}
            selectedId={activePageId}
            onSelect={setSelectedPageId}
          />
        )}
        {pages.length > 0 && (
          <section className="pui-card">
            <h2 className="pui-card-title">{t("scannerScreen.capturedTitle")}</h2>
            {pages.map((page, index) => (
              <div key={page.id} className="scanner-review-page">
                <img
                  src={page.src}
                  alt={`${t("scannerScreen.page")} ${index + 1}`}
                  className="scanner-review-thumb"
                />
                <div className="scanner-review-actions">
                  <IconButton
                    icon="rotate"
                    label={t("scannerScreen.rotate")}
                    onClick={() => rotatePage(page.id)}
                  />
                  <IconButton
                    icon="trash"
                    label={t("scannerScreen.delete")}
                    onClick={() => deletePage(page.id)}
                  />
                </div>
              </div>
            ))}
            <div className="scanner-review-actions">
              <Button variant="secondary" icon="file" onClick={downloadAll}>
                {t("scannerScreen.download")}
              </Button>
              <Button variant="primary" onClick={printPages}>
                {t("scannerScreen.print")}
              </Button>
            </div>
          </section>
        )}
        <footer className="pui-footer">
          <Button
            variant="secondary"
            icon="crop"
            onClick={takeCroppedPhoto}
            disabled={!isOpenCvReady || !hasDocumentInFrame}
          >
            {t("scannerScreen.scanDocument")}
          </Button>
          <Button
            variant="primary"
            icon="camera"
            onClick={takeNormalPhoto}
            disabled={!isOpenCvReady}
          >
            {t("scannerScreen.captureDocument")}
          </Button>
        </footer>
        <canvas ref={canvasRef} className="hidden-canvas" />
      </Screen>
    </Theme>
  )
}
