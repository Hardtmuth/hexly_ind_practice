import React, { useEffect, useRef, useState } from 'react'

export const WebcamCapture: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [photo, setPhoto] = useState<string | null>(null) // Хранит Base64 строку снимка
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stream: MediaStream | null = null

    const startCamera = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        if (videoRef.current) {
          videoRef.current.srcObject = stream
        }
      } catch (err) {
        setError('Доступ к камере запрещен или она не подключена')
        console.error(err)
      }
    }

    startCamera()

    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop())
      }
    }
  }, [])

  const takePhoto = () => {
    const video = videoRef.current
    const canvas = canvasRef.current

    if (video && canvas) {
      const ctx = canvas.getContext('2d')
      if (ctx) {
        // Размер холста = размеру видеопотока
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight

        // Текущий кадр видео на холсте
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

        // Изображение в формате Base64 (PNG по умолчанию)
        const dataUrl = canvas.toDataURL('image/png')
        setPhoto(dataUrl)
      }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
      {error && <p style={{ color: 'red' }}>{error}</p>}

      <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
        {/* Стрим с камеры */}
        <div>
          <h3>Камера в реальном времени</h3>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{ width: '100%', maxWidth: '400px', border: '2px solid #ccc' }}
          />
        </div>

        {/* Результат снимка */}
        {photo && (
          <div>
            <h3>Сделанный снимок</h3>
            <img src={photo} alt="Скриншот" style={{ width: '100%', maxWidth: '400px', border: '2px solid green' }} />
          </div>
        )}
      </div>

      <button onClick={takePhoto} style={{ padding: '10px 20px', fontSize: '16px', cursor: 'pointer' }}>
        Сделать снимок 📸
      </button>

      {/* Скрытый холст, для генерации картинки */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  )
}
