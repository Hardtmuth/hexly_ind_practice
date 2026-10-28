import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../i18n/useTranslation'

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    cv: any
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const WebcamCapture: React.FC = () => {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const [photo, setPhoto] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isOpenCvReady, setIsOpenCvReady] = useState<boolean>(false)

  // Координаты последней успешно найденной рамки для обрезки
  const [hasDocumentInFrame, setHasDocumentInFrame] = useState<boolean>(false)
  const lastPointsRef = useRef<number[] | null>(null)

  // 1. Проверка инициализации OpenCV.js
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

  // 2. Инициализация камеры и обработка видеопотока в OpenCV
  useEffect(() => {
    let stream: MediaStream | null = null
    let animationFrameId: number

    /* eslint-disable @typescript-eslint/no-explicit-any */
    let cap: any = null
    let src: any = null
    let dst: any = null
    let contours: any = null
    let hierarchy: any = null
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const startCamera = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'environment' }, 
          audio: false 
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
        setError(t('errors.cameraAccessDenied'))
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
          if (!videoRef.current || videoRef.current.paused || videoRef.current.ended) return

          cap.read(src)
          cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY)

          const ksize = new cv.Size(5, 5)
          cv.GaussianBlur(dst, dst, ksize, 0, 0, cv.BORDER_DEFAULT)
          cv.Canny(dst, dst, 75, 200, 3, false)

          const M = cv.Mat.ones(3, 3, cv.CV_8U)
          cv.dilate(dst, dst, M, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue())
          M.delete()

          cv.findContours(dst, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE)

          let maxArea = 0

          /* eslint-disable @typescript-eslint/no-explicit-any */
          let pageContour: any = null
          /* eslint-enable @typescript-eslint/no-explicit-any */

          for (let i = 0; i < contours.size(); ++i) {
            const contour = contours.get(i)
            const area = cv.contourArea(contour)

            if (area > (video.width * video.height * 0.1)) {
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

          const ctx = overlayCanvas.getContext('2d', { willReadFrequently: true })
          if (ctx) {
            ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)

            if (pageContour) {
              setHasDocumentInFrame(true)
              // Сохраняем плоский массив из 8 чисел: [x1,y1, x2,y2, x3,y3, x4,y4]
              lastPointsRef.current = Array.from(pageContour.data32S)

              ctx.strokeStyle = '#00FF00'
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

          animationFrameId = requestAnimationFrame(processVideo)
        } catch (e) {
          console.error(t('errors.opencvFrameProcessing'), e)
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
        stream.getTracks().forEach(track => track.stop())
      }
      if (src) src.delete()
      if (dst) dst.delete()
      if (contours) contours.delete()
      if (hierarchy) hierarchy.delete()
      if (cap) cap.delete()
    }
  }, [t, isOpenCvReady])

  // Обычный полный снимок экрана
  const takeNormalPhoto = () => {
    const video = videoRef.current
    const canvas = canvasRef.current

    if (video && canvas) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight

        ctx.translate(canvas.width, 0)
        ctx.scale(-1, 1)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        ctx.setTransform(1, 0, 0, 1, 0, 0)

        setPhoto(canvas.toDataURL('image/png'))
      }
    }
  }

  // Обрезка перспективы по 4 точкам оверлея
  const takeCroppedPhoto = () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    const cv = window.cv

    if (!video || !canvas || !cv || !lastPointsRef.current) return

    try {
      // 1. Извлекаем 4 точки из рефа
      const pts = lastPointsRef.current
      const p1 = { x: pts[0], y: pts[1] }
      const p2 = { x: pts[2], y: pts[3] }
      const p3 = { x: pts[4], y: pts[5] }
      const p4 = { x: pts[6], y: pts[7] }
      const origPoints = [p1, p2, p3, p4]

      // 2. Сортируем точки, чтобы точно знать где какой угол (TL, TR, BR, BL)
      // Сортируем по X, чтобы отделить левые точки от правых
      const sortedByX = [...origPoints].sort((a, b) => a.x - b.x)
      const leftMost = [sortedByX[0], sortedByX[1]]
      const rightMost = [sortedByX[2], sortedByX[3]]

      // Внутри левых и правых пар сортируем по Y
      const tl = leftMost[0].y < leftMost[1].y ? leftMost[0] : leftMost[1]
      const bl = leftMost[0].y < leftMost[1].y ? leftMost[1] : leftMost[0]
      const tr = rightMost[0].y < rightMost[1].y ? rightMost[0] : rightMost[1]
      const br = rightMost[0].y < rightMost[1].y ? rightMost[1] : rightMost[0]

      // 3. Вычисляем целевые пропорции результирующего А4 (берем максимум из сторон)
      const widthA = Math.hypot(br.x - bl.x, br.y - bl.y)
      const widthB = Math.hypot(tr.x - tl.x, tr.y - tl.y)
      const maxWidth = Math.max(widthA, widthB)

      const heightA = Math.hypot(tr.x - br.x, tr.y - br.y)
      const heightB = Math.hypot(tl.x - bl.x, tl.y - bl.y)
      const maxHeight = Math.max(heightA, heightB)

      // Set canvas size
      canvas.width = maxWidth
      canvas.height = maxHeight

      // 4. Захватываем текущий чистый кадр из видео в матрицу OpenCV
      const imageSrc = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4)
      const imageDst = new cv.Mat(maxHeight, maxWidth, cv.CV_8UC4)

      // Напрямую берем кадр из HTMLVideoElement
      const tempCap = new cv.VideoCapture(video)
      tempCap.read(imageSrc)

      // 5. Проводим трансформацию геометрии
      const srcCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y])
      const dstCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, maxWidth, 0, maxWidth, maxHeight, 0, maxHeight])

      const dsize = new cv.Size(maxWidth, maxHeight)
      const M = cv.getPerspectiveTransform(srcCoords, dstCoords)

      cv.warpPerspective(imageSrc, imageDst, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar())

      // 6. Отрисовываем матрицу на холст
      cv.imshow(canvas, imageDst)

      // Так как оригинальный поток не отзеркален, а мы хотим видеть его привычно:
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx) {
        // Создаем временную копию отсканированного кадра
        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = canvas.width
        tempCanvas.height = canvas.height
        const tempCtx = tempCanvas.getContext('2d')
        if (tempCtx) {
          tempCtx.drawImage(canvas, 0, 0)

          // Переворачиваем результат обратно для пользователя, убирая зеркальный эффект камеры
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          ctx.translate(canvas.width, 0)
          ctx.scale(-1, 1)
          ctx.drawImage(tempCanvas, 0, 0)
          ctx.setTransform(1, 0, 0, 1, 0, 0)
        }
      }
      setPhoto(canvas.toDataURL('image/png'))

      imageSrc.delete()
      imageDst.delete()
      srcCoords.delete()
      dstCoords.delete()
      M.delete()
      } catch (e) {
        console.error(t('errors.opencvPerspectiveCorrection'), e)
      }
    }

    return (
    <div className="main-container">
      {/* Сообщения об ошибках и статусе загрузки */}
      {error && <p className="error-message">{error}</p>}
      {!isOpenCvReady && <p className="loading-message">{t('loading')}</p>}

      <div className="video-container">
        {/* БЛОК С КАМЕРОЙ И ОВЕРЛЕЕМ */}
        <div>
          <h3>{t('mainPage.realTimeCamera')}</h3>
          <div className="video-wrapper">
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              muted 
              className="video-stream" 
            />
            {/* Холст, на котором OpenCV рисует зеленую рамку А4 поверх видео */}
            <canvas
              ref={overlayCanvasRef}
              className="overlay-canvas"
            />
          </div>
        </div>

        {/* Результат снимка (Превью) */}
        {photo && (
          <div>
            <h3>{t('mainPage.picturePreview')}</h3>
            <img 
              src={photo}
              alt={t('mainPage.picturePreview')} 
              className="photo-preview" 
            />
          </div>
        )}
      </div>

      {/* КНОПКИ УПРАВЛЕНИЯ */}
      <div className="button-group">
        <button
          className="take-photo-button"
          onClick={takeNormalPhoto} 
          disabled={!isOpenCvReady}
        >
          {t('mainPage.takePhotoButton')}
        </button>

        <button
          className="scan-photo-button"
          onClick={takeCroppedPhoto} 
          disabled={!isOpenCvReady || !hasDocumentInFrame}
        >
          {t('mainPage.scanDocument')}
        </button>
      </div>

      {/* Скрытый холст для внутренней математической обработки фото */}
      <canvas ref={canvasRef} className="hidden-canvas" />
    </div>
  )
}