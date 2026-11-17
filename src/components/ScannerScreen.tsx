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
  // SegmentedControl,
  EmptyState,
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

// Пропорции листа A4 (210 × 297) — формат рамки камеры
const A4_RATIO = 210 / 297

// Родной сенсор камеры ландшафтный (2560×1440). Именно его и запрашиваем:
// после физического поворота корпуса программный поворот на 90° даёт
// портретный кадр 1440×2560 без обрезки. Если драйвер всё равно отдаёт
// портретный поток, поворот не применяем — иначе кадр станет ландшафтным.
// Если текст ляжет на бок в другую сторону, меняем 90 на 270.
const CAMERA_ROTATION_DEG = 90
// Поворот для потока, который драйвер уже отдаёт портретным:
// сохраняем исходный переворот камеры на 180°.
const PORTRAIT_STREAM_ROTATION_DEG = 180

// type ScanFilter = "color" | "grayscale" | "text"

export const ScannerScreen = () => {
  const { t } = useTranslation()

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const pagesScrollRef = useRef<HTMLElement | null>(null)

  const [canScrollLeft, setCanScrollLeft] = useState<boolean>(false)
  const [canScrollRight, setCanScrollRight] = useState<boolean>(false)
  const [isCapturing, setIsCapturing] = useState<boolean>(false)
  const [pages, setPages] = useState<ScannedPage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isOpenCvReady, setIsOpenCvReady] = useState<boolean>(false)
  const [hasDocumentInFrame, setHasDocumentInFrame] = useState<boolean>(false)
  const [isLandscapeStream, setIsLandscapeStream] = useState<boolean>(true)
  const lastPointsRef = useRef<number[] | null>(null)
  // const [filter, setFilter] = useState<ScanFilter>("color")

  // Итоговый кадр на экране всегда портретный: ландшафтный поток поворачиваем
  // на 90°, портретный оставляем как есть (только исходный переворот 180°).
  const rotationDeg = isLandscapeStream
    ? CAMERA_ROTATION_DEG
    : PORTRAIT_STREAM_ROTATION_DEG
  const rotationRad = (rotationDeg * Math.PI) / 180
  const isQuarterTurn = isLandscapeStream && rotationDeg % 180 !== 0

  const mediaStyle: CSSProperties = isQuarterTurn
    ? {
        position: "absolute",
        top: "50%",
        left: "50%",
        width: `${100 / A4_RATIO}%`,
        height: `${A4_RATIO * 100}%`,
        transform: `translate(-50%, -50%) rotate(${rotationDeg}deg)`,
        // cover отрезает пустые поля сенсора по краям листа: при 9:16
        // и A4 это ровно те полосы, которые оставались при contain.
        objectFit: "cover",
        pointerEvents: "none",
      }
    : {
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        transform: `rotate(${rotationDeg}deg)`,
        objectFit: "cover",
        pointerEvents: "none",
      }

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
    let stopped = false
    let cap: any = null
    let src: any = null
    let smallSrc: any = null
    let dst: any = null
    let contours: any = null
    let hierarchy: any = null

    const startCamera = async () => {
      try {
        // Запрашиваем родной ландшафтный режим сенсора 2560×1440
        // Портретный кадр получаем программным поворотом на 90°
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { exact: 2560 },
              height: { exact: 1440 },
              facingMode: "environment",
            },
            audio: false,
          })
        } catch (e) {
          if ((e as { name?: string })?.name !== "OverconstrainedError") throw e
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 2560 },
              height: { ideal: 1440 },
              facingMode: "environment",
            },
            audio: false,
          })
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.onloadedmetadata = () => {
            if (videoRef.current) {
              const width = videoRef.current.videoWidth
              const height = videoRef.current.videoHeight
              videoRef.current.width = width
              videoRef.current.height = height
              // Фактический режим
              console.info(`[scanner] stream ${width}x${height}`)
              setIsLandscapeStream(width > height)
              if (isOpenCvReady) {
                initOpenCVProcessing()
              }
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

      // Контур ищем на уменьшенной копии кадра: на полном кадре высокого
      // разрешения OpenCV обрабатывает каждый кадр слишком медленно.
      // Точки рамки затем масштабируются обратно в координаты потока.
      const DETECT_MAX = 640
      const detectScale = Math.min(1, DETECT_MAX / Math.max(video.width, video.height))
      const detectW = Math.max(1, Math.round(video.width * detectScale))
      const detectH = Math.max(1, Math.round(video.height * detectScale))
      const pointScaleX = video.width / detectW
      const pointScaleY = video.height / detectH

      overlayCanvas.width = detectW
      overlayCanvas.height = detectH

      cap = new cv.VideoCapture(video)
      src = new cv.Mat(video.height, video.width, cv.CV_8UC4)
      smallSrc = new cv.Mat(detectH, detectW, cv.CV_8UC4)
      dst = new cv.Mat(detectH, detectW, cv.CV_8UC1)
      contours = new cv.MatVector()
      hierarchy = new cv.Mat()

      const processVideo = () => {
        try {
          if (
            !videoRef.current ||
            videoRef.current.paused ||
            videoRef.current.ended
          ) {
            // Видео может временно встать на паузу — цикл продолжится в finally.
            return
          }

          cap.read(src)
          cv.resize(src, smallSrc, new cv.Size(detectW, detectH), 0, 0, cv.INTER_AREA)
          cv.cvtColor(smallSrc, dst, cv.COLOR_RGBA2GRAY)

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
          const frameArea = detectW * detectH

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

          const ctx = overlayCanvas.getContext("2d", {
            willReadFrequently: true,
          })
          if (ctx) {
            ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)

            if (pageContour) {
              setHasDocumentInFrame(true)
              // Координаты контура найдены на уменьшенном кадре - возврат в масштаб исходного потока для обрезки.
              const points: number[] = Array.from(
                pageContour.data32S as ArrayLike<number>,
              )
              for (let i = 0; i < points.length; i += 2) {
                points[i] = Math.round(points[i] * pointScaleX)
                points[i + 1] = Math.round(points[i + 1] * pointScaleY)
              }
              lastPointsRef.current = points

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

              pageContour.delete()
            } else {
              setHasDocumentInFrame(false)
            }
          }

        } catch (e) {
          console.error(t("errors.opencvFrameProcessing"), e)
        } finally {
          // Планируем следующий кадр даже после ошибки: один сбой OpenCV не должен останавливать детекцию документа.
          if (!stopped) {
            animationFrameId = requestAnimationFrame(processVideo)
          }
        }
      }

      animationFrameId = requestAnimationFrame(processVideo)
    }

    if (isOpenCvReady) {
      startCamera()
    }

    return () => {
      stopped = true
      cancelAnimationFrame(animationFrameId)
      if (stream) {
        stream.getTracks().forEach((track) => track.stop())
      }
      if (src) src.delete()
      if (smallSrc) smallSrc.delete()
      if (dst) dst.delete()
      if (contours) contours.delete()
      if (hierarchy) hierarchy.delete()
    }
  }, [t, isOpenCvReady])

  // Применение фильтра к оверлею камеры
  /* useEffect(() => {
    const canvas = overlayCanvasRef.current
    if (!canvas) return
    canvas.style.filter = "none" 
      /* filter === "grayscale"
        ? "grayscale(1)"
        : filter === "text"
          ? "grayscale(1) contrast(2)"
          : "none"
  }, [filter])
 */
  const takeNormalPhoto = () => {
    const video = videoRef.current
    const canvas = canvasRef.current

    if (video && canvas) {
      const ctx = canvas.getContext("2d", { willReadFrequently: true })
      if (ctx) {
        canvas.width = isQuarterTurn ? video.videoHeight : video.videoWidth
        canvas.height = isQuarterTurn ? video.videoWidth : video.videoHeight

        ctx.translate(canvas.width / 2, canvas.height / 2)
        ctx.rotate(rotationRad)
        ctx.drawImage(
          video,
          -video.videoWidth / 2,
          -video.videoHeight / 2,
          video.videoWidth,
          video.videoHeight,
        )
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

  const takeCroppedPhoto = async () => {
    if (isCapturing) return
    const video = videoRef.current
    const canvas = canvasRef.current
    const cv = window.cv

    if (!video || !canvas || !cv || !lastPointsRef.current) return

    setIsCapturing(true)
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
      const maxWidth = Math.round(Math.max(widthA, widthB))

      const heightA = Math.hypot(tr.x - br.x, tr.y - br.y)
      const heightB = Math.hypot(tl.x - bl.x, tl.y - bl.y)
      const maxHeight = Math.round(Math.max(heightA, heightB))

      // Выпрямленное изображение имеет размеры maxWidth × maxHeight,
      // а итоговый холст при повороте на 90° меняет их местами.
      canvas.width = isQuarterTurn ? maxHeight : maxWidth
      canvas.height = isQuarterTurn ? maxWidth : maxHeight

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

      // Берём несколько кадров подряд и оставляем самый резкий:
      // мера резкости — дисперсия лапласиана по всему изображению.
      const FRAME_COUNT = 5
      const FRAME_INTERVAL_MS = 90
      let bestFrame: any = null
      let bestScore = -1

      const frameCap = new cv.VideoCapture(video)

      for (let i = 0; i < FRAME_COUNT; i++) {
        const frame = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4)
        frameCap.read(frame)

        const warped = new cv.Mat(maxHeight, maxWidth, cv.CV_8UC4)
        cv.warpPerspective(
          frame,
          warped,
          M,
          dsize,
          cv.INTER_CUBIC,
          cv.BORDER_CONSTANT,
          new cv.Scalar(),
        )
        frame.delete()

        const gray = new cv.Mat()
        cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY)
        const laplacian = new cv.Mat()
        cv.Laplacian(gray, laplacian, cv.CV_64F)
        const mean = new cv.Mat()
        const stddev = new cv.Mat()
        cv.meanStdDev(laplacian, mean, stddev)
        const score = stddev.data64F[0] ** 2
        gray.delete()
        laplacian.delete()
        mean.delete()
        stddev.delete()

        if (score > bestScore) {
          if (bestFrame) bestFrame.delete()
          bestFrame = warped
          bestScore = score
        } else {
          warped.delete()
        }

        if (i < FRAME_COUNT - 1) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, FRAME_INTERVAL_MS)
          })
        }
      }

      srcCoords.delete()
      dstCoords.delete()
      M.delete()

      if (!bestFrame) return

      // Лёгкая резкость (unsharp mask) поверх выбранного кадра.
      const blurred = new cv.Mat()
      const sharpened = new cv.Mat()
      cv.GaussianBlur(bestFrame, blurred, new cv.Size(0, 0), 1.2)
      cv.addWeighted(bestFrame, 1.6, blurred, -0.6, 0, sharpened)
      blurred.delete()
      bestFrame.delete()

      // imshow выводит Mat в нативном размере, поэтому сначала рисуем
      // выпрямленный кадр в отдельный холст, а затем поворачиваем его.
      const rectified = document.createElement("canvas")
      rectified.width = maxWidth
      rectified.height = maxHeight
      cv.imshow(rectified, sharpened)
      sharpened.delete()

      const ctx = canvas.getContext("2d", { willReadFrequently: true })
      if (ctx) {
        ctx.translate(canvas.width / 2, canvas.height / 2)
        ctx.rotate(rotationRad)
        ctx.drawImage(rectified, -maxWidth / 2, -maxHeight / 2, maxWidth, maxHeight)
        ctx.setTransform(1, 0, 0, 1, 0, 0)
      }

      const newPage: ScannedPage = {
        id: Date.now().toString(),
        src: canvas.toDataURL("image/png"),
        rotation: 0,
        type: "scan",
      }
      setPages((prev) => [...prev, newPage])
    } catch (e) {
      console.error(t("errors.opencvPerspectiveCorrection"), e)
    } finally {
      setIsCapturing(false)
    }
  }

  /* eslint-enable @typescript-eslint/no-explicit-any */

  const rotatePage = (id: string) => {
    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, rotation: (p.rotation + 90) % 360 } : p)))
  }

  const deletePage = (id: string) => {
    setPages((prev) => prev.filter((p) => p.id !== id))
  }

  // Состояние стрелок прокрутки ряда отсканированных страниц
  const updateScrollButtons = () => {
    const el = pagesScrollRef.current
    if (!el) {
      setCanScrollLeft(false)
      setCanScrollRight(false)
      return
    }
    setCanScrollLeft(el.scrollLeft > 1)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }

  const scrollPages = (direction: -1 | 1) => {
    const el = pagesScrollRef.current
    if (!el) return
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" })
  }

  useEffect(() => {
    updateScrollButtons()
    const el = pagesScrollRef.current
    if (!el) return
    const observer = new ResizeObserver(updateScrollButtons)
    observer.observe(el)
    return () => observer.disconnect()
  }, [pages.length])

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
      <Screen
        className="scanner-screen"
        style={
          {
            "--scanner-frame-ratio": A4_RATIO,
          } as CSSProperties
        }
      >
        <Header
          logoSrc="/logo.svg"
          logoAlt="ПЕЧАТЬ.ТУТ"
        />
        <Title subtitle={t("scannerScreen.subtitle")}>
          {t("scannerScreen.title")}
        </Title>
        <div className="scanner-camera-area">
          <ScannerFrame className="scanner-frame" label={t("scannerScreen.frameLabel")}>
            {isOpenCvReady ? (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="scanner-video"
                  style={mediaStyle}
                />
                <canvas
                  ref={overlayCanvasRef}
                  className="scanner-overlay-canvas"
                  style={mediaStyle}
                />
                <div className="scanner-a4-guide" aria-hidden="true">
                  <span className="scanner-a4-corner scanner-a4-corner--tl" />
                  <span className="scanner-a4-corner scanner-a4-corner--tr" />
                  <span className="scanner-a4-corner scanner-a4-corner--bl" />
                  <span className="scanner-a4-corner scanner-a4-corner--br" />
                </div>
                {/* {!error && (
                  <p className="pui-frame-label scanner-hint" role="status">
                    {t("scannerScreen.statusReady")}
                  </p>
                )} */}
              </>
            ) : (
              <EmptyState
                title={t("scannerScreen.cameraNotReadyTitle")}
                description={t("scannerScreen.cameraNotReadyDescription")}
                icon="camera"
              />
            )}
          </ScannerFrame>
        </div>
        {error && <Status tone="error">{error}</Status>}
        {/* <SegmentedControl
          label={t("scannerScreen.filterLabel")}
          value={filter}
          onChange={(value) => setFilter(value as ScanFilter)}
          options={[
            { value: "color", label: t("scannerScreen.filterColor") },
            { value: "grayscale", label: t("scannerScreen.filterGrayscale") },
            { value: "text", label: t("scannerScreen.filterText") },
          ]}
        /> */}
        <section className="pui-footer">
          <Button
            variant="secondary"
            icon="camera"
            onClick={takeNormalPhoto}
            disabled={!isOpenCvReady}
          >
            {t("scannerScreen.captureDocument")}
          </Button>
          <Button
            variant="primary"
            icon="crop"
            onClick={takeCroppedPhoto}
            disabled={!isOpenCvReady || !hasDocumentInFrame || isCapturing}
          >
            {t("scannerScreen.scanDocument")}
          </Button>
          
        </section>
        <div className="scanner-pages-panel">
          <div className="scanner-results-head">
            <h2>{t("scannerScreen.capturedTitle")}</h2>
            <span className="scanner-results-count">{pages.length}</span>
          </div>
          <div className="scanner-results-strip">
            <IconButton
              className={`scanner-scroll-btn scanner-scroll-btn--prev${canScrollLeft ? "" : " scanner-scroll-btn--hidden"}`}
              icon="arrow"
              label={t("scannerScreen.scrollLeft")}
              onClick={() => scrollPages(-1)}
              disabled={!canScrollLeft}
            />
            <section
              ref={pagesScrollRef}
              className="scanner-pages"
              onScroll={updateScrollButtons}
              aria-label={t("scannerScreen.capturedTitle")}
            >
              {pages.length === 0 ? (
                <p className="scanner-results-empty">
                  {t("scannerScreen.capturedEmpty")}
                </p>
              ) : (
                pages.map((page, index) => (
                  <article key={page.id} className="scanner-page">
                    <div className="scanner-page-preview">
                      <img
                        src={page.src}
                        alt={`${t("scannerScreen.page")} ${index + 1}`}
                        className="scanner-page-image"
                        style={{ transform: `rotate(${page.rotation}deg)` }}
                      />
                      <span className="scanner-page-number" aria-hidden="true">
                        {index + 1}
                      </span>
                    </div>
                    <div className="scanner-page-actions">
                      <IconButton
                        className="scanner-page-action"
                        icon="rotate"
                        label={t("scannerScreen.rotate")}
                        onClick={() => rotatePage(page.id)}
                      />
                      <IconButton
                        className="scanner-page-action"
                        icon="trash"
                        label={t("scannerScreen.delete")}
                        onClick={() => deletePage(page.id)}
                      />
                    </div>
                  </article>
                ))
              )}
            </section>
            <IconButton
              className={`scanner-scroll-btn scanner-scroll-btn--next${canScrollRight ? "" : " scanner-scroll-btn--hidden"}`}
              icon="arrow"
              label={t("scannerScreen.scrollRight")}
              onClick={() => scrollPages(1)}
              disabled={!canScrollRight}
            />
          </div>
          <div className="scanner-pages-actions">
            <Button
              variant="secondary"
              size="small"
              icon="file"
              onClick={downloadAll}
              disabled={pages.length === 0}
            >
              {t("scannerScreen.download")}
            </Button>
            <Button
              variant="primary"
              size="small"
              onClick={printPages}
              disabled={pages.length === 0}
            >
              {t("scannerScreen.print")}
            </Button>
          </div>
        </div>
        {/* {pages.length > 0 && (
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
        )} */}
        
        <canvas ref={canvasRef} className="hidden-canvas" />
      </Screen>
    </Theme>
  )
}
