const fs = require('fs')
// UPDATED: Changed import from 'canvas' to '@napi-rs/canvas'
const { createCanvas, registerFont, loadImage } = require('@napi-rs/canvas') 
const EmojiDbLib = require('emoji-db')
// Removed: const { loadImage } = require('canvas') // Already included in the new import
const loadImageFromUrl = require('./image-load-url')
const sharp = require('sharp')
const { Jimp, JimpMime } = require('jimp')
const smartcrop = require('smartcrop-sharp')
const runes = require('runes')
const zlib = require('zlib')
const { Telegram } = require('telegraf')

const emojiDb = new EmojiDbLib({ useDefaultDb: true })

function loadFont () {
  console.log('font load start')
  const fontsDir = 'assets/fonts/'

  fs.readdir(fontsDir, (_err, files) => {
    files.forEach((file) => {
      try {
        registerFont(`${fontsDir}${file}`, { family: file.replace(/\.[^/.]+$/, '') })
      } catch (error) {
        console.error(`${fontsDir}${file} not font file`)
      }
    })
  })

  console.log('font load end')
}

loadFont()

const emojiImageByBrand = require('./emoji-image')

const LRU = require('lru-cache')

const avatarCache = new LRU({
  max: 20,
  maxAge: 1000 * 60 * 5
})

// write a nodejs function that accepts 2 colors. the first is the background color and the second is the text color. as a result, the first color should come out brighter or darker depending on the contrast. for example, if the first text is dark, then make the second brighter and return it. you need to change not the background color, but the text color

// here are all the possible colors that will be passed as the second argument. the first color can be any
class ColorContrast {
  constructor () {
    this.brightnessThreshold = 175 // A threshold to determine when a color is considered bright or dark
  }

  getBrightness (color) {
    // Calculates the brightness of a color using the formula from the WCAG 2.0
    // See: https://www.w3.org/TR/WCAG20-TECHS/G18.html#G18-tests
    const [r, g, b] = this.hexToRgb(color)
    return (r * 299 + g * 587 + b * 114) / 1000
  }

  hexToRgb (hex) {
    // Converts a hex color string to an RGB array
    const r = parseInt(hex.substring(1, 3), 16)
    const g = parseInt(hex.substring(3, 5), 16)
    const b = parseInt(hex.substring(5, 7), 16)
    return [r, g, b]
  }

  rgbToHex ([r, g, b]) {
    // Converts an RGB array to a hex color string
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
  }

  adjustBrightness (color, amount) {
    // Adjusts the brightness of a color by a specified amount
    const [r, g, b] = this.hexToRgb(color)
    const newR = Math.max(0, Math.min(255, r + amount))
    const newG = Math.max(0, Math.min(255, g + amount))
    const newB = Math.max(0, Math.min(255, b + amount))
    return this.rgbToHex([newR, newG, newB])
  }

  getContrastRatio (background, foreground) {
    // Calculates the contrast ratio between two colors using the formula from the WCAG 2.0
    // See: https://www.w3.org/TR/WCAG20-TECHS/G18.html#G18-tests
    const brightness1 = this.getBrightness(background)
    const brightness2 = this.getBrightness(foreground)
    const lightest = Math.max(brightness1, brightness2)
    const darkest = Math.min(brightness1, brightness2)
    return (lightest + 0.05) / (darkest + 0.05)
  }

  adjustContrast (background, foreground) {
    // Adjusts the brightness of the foreground color to meet the minimum contrast ratio
    // with the background color
    const contrastRatio = this.getContrastRatio(background, foreground)
    const brightnessDiff = this.getBrightness(background) - this.getBrightness(foreground)
    if (contrastRatio >= 4.5) {
      return foreground // The contrast ratio is already sufficient
    } else if (brightnessDiff >= 0) {
      // The background is brighter than the foreground
      const amount = Math.ceil((this.brightnessThreshold - this.getBrightness(foreground)) / 2)
      return this.adjustBrightness(foreground, amount)
    } else {
      // The background is darker than the foreground
      const amount = Math.ceil((this.getBrightness(foreground) - this.brightnessThreshold) / 2)
      return this.adjustBrightness(foreground, -amount)
    }
  }
}

class QuoteGenerate {
  constructor (botToken) {
    this.telegram = new Telegram(botToken)
  }

  async avatarImageLatters (letters, color) {
    const size = 500
    const canvas = createCanvas(size, size)
    const context = canvas.getContext('2d')

    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height)

    gradient.addColorStop(0, color[0])
    gradient.addColorStop(1, color[1])

    context.fillStyle = gradient
    context.fillRect(0, 0, canvas.width, canvas.height)

    const drawLetters = await this.drawMultilineText(
      letters,
      null,
      size / 2,
      '#FFF',
      0,
      size,
      size * 5,
      size * 5
    )

    context.drawImage(drawLetters, (canvas.width - drawLetters.width) / 2, (canvas.height - drawLetters.height) / 1.5)

    return canvas.toBuffer()
  }

  async downloadAvatarImage (user) {
    let avatarImage

    let nameLatters
    if (user.first_name && user.last_name) nameLatters = runes(user.first_name)[0] + (runes(user.last_name || '')[0])
    else {
      let name = user.first_name || user.name || user.title
      name = name.toUpperCase()
      const nameWord = name.split(' ')

      if (nameWord.length > 1) nameLatters = runes(nameWord[0])[0] + runes(nameWord.splice(-1)[0])[0]
      else nameLatters = runes(nameWord[0])[0]
    }

    const cacheKey = user.id

    const avatarImageCache = avatarCache.get(cacheKey)

    const avatarColorArray = [
      [ '#FF885E', '#FF516A' ], // red
      [ '#FFCD6A', '#FFA85C' ], // orange
      [ '#E0A2F3', '#D669ED' ], // purple
      [ '#A0DE7E', '#54CB68' ], // green
      [ '#53EDD6', '#28C9B7' ], // sea
      [ '#72D5FD', '#2A9EF1' ], // blue
      [ '#FFA8A8', '#FF719A' ] // pink
    ]

    const nameIndex = Math.abs(user.id) % 7

    const avatarColor = avatarColorArray[nameIndex]

    if (avatarImageCache) {
      avatarImage = avatarImageCache
    } else if (user.photo && user.photo.url) {
      avatarImage = await loadImage(user.photo.url)
    } else {
      try {
        let userPhoto, userPhotoUrl

        if (user.photo && user.photo.big_file_id) userPhotoUrl = await this.telegram.getFileLink(user.photo.big_file_id).catch(() => {})

        if (!userPhotoUrl) {
          const getChat = await this.telegram.getChat(user.id).catch(() => {})

          if (getChat && getChat.photo && getChat.photo.big_file_id) userPhoto = getChat.photo.big_file_id

          if (userPhoto) userPhotoUrl = await this.telegram.getFileLink(userPhoto).catch(() => {})

          else if (user.username) userPhotoUrl = `https://telega.one/i/userpic/320/${user.username}.jpg`

          else avatarImage = await loadImage(await this.avatarImageLatters(nameLatters, avatarColor)).catch(() => {})
        }

        if (userPhotoUrl) {
          const imageBuffer = await loadImageFromUrl(userPhotoUrl).catch((error) => {
            console.warn('Failed to load user photo from URL:', error.message)
            return null
          })

          if (imageBuffer) {
            avatarImage = await loadImage(imageBuffer).catch((error) => {
              console.warn('Failed to process user photo buffer:', error.message)
              return null
            })
          }
        }

        if (avatarImage) {
          avatarCache.set(cacheKey, avatarImage)
        }
      } catch (error) {
        console.warn('Error getting user photo:', error.message)
        avatarImage = null
      }

      // Fallback to letters avatar if no image was loaded
      if (!avatarImage) {
        try {
          avatarImage = await loadImage(await this.avatarImageLatters(nameLatters, avatarColor))
          avatarCache.set(cacheKey, avatarImage)
        } catch (error) {
          console.warn('Failed to create letters avatar:', error.message)
          avatarImage = null
        }
      }
    }

    return avatarImage
  }

  ungzip (input, options) {
    return new Promise((resolve, reject) => {
      zlib.gunzip(input, options, (error, result) => {
        if (!error) resolve(result)
        else reject(Error(error))
      })
    })
  }

  async downloadMediaImage (media, mediaSize, type = 'id', crop = true) {
    try {
      let mediaUrl
      if (type === 'id') mediaUrl = await this.telegram.getFileLink(media).catch(console.error)
      else mediaUrl = media

      if (!mediaUrl) {
        console.warn('Failed to get media URL, skipping media')
        return null
      }

      const load = await loadImageFromUrl(mediaUrl).catch((error) => {
        console.warn('Failed to load image from URL:', error.message)
        return null
      })

      if (!load) {
        console.warn('Failed to load media, skipping')
        return null
      }

      if (crop || (mediaUrl && mediaUrl.match(/.webp/))) {
        try {
          const imageSharp = sharp(load)
          const imageMetadata = await imageSharp.metadata()
          const sharpPng = await imageSharp.png({ lossless: true, force: true }).toBuffer()

          if (!imageMetadata || !imageMetadata.width || !imageMetadata.height || !sharpPng) {
            // Fallback to original image without processing
            try {
              return await loadImage(load)
            } catch (fallbackError) {
              console.warn('Failed to load original image as fallback:', fallbackError.message)
              return null
            }
          }

          let croppedImage

          if (imageMetadata.format === 'webp') {
            try {
              const jimpImage = await Jimp.read(sharpPng)
              croppedImage = await jimpImage.autocrop().getBuffer(JimpMime.png)
            } catch (jimpError) {
              console.warn('Failed to process webp with Jimp, using original:', jimpError.message)
              croppedImage = sharpPng
            }
          } else {
            try {
              const smartcropResult = await smartcrop.crop(sharpPng, { width: mediaSize, height: imageMetadata.height })
              const crop = smartcropResult.topCrop

              croppedImage = await imageSharp.extract({ width: crop.width, height: crop.height, left: crop.x, top: crop.y }).png({ lossless: true, force: true }).toBuffer()
            } catch (cropError) {
              console.warn('Failed to crop image, using original:', cropError.message)
              croppedImage = sharpPng
            }
          }

          try {
            return await loadImage(croppedImage)
          } catch (loadError) {
            console.warn('Failed to load processed image, trying original:', loadError.message)
            try {
              return await loadImage(load)
            } catch (originalError) {
              console.warn('Failed to load original image as final fallback:', originalError.message)
              return null
            }
          }
        } catch (sharpError) {
          console.warn('Failed to process image with Sharp, trying original:', sharpError.message)
          try {
            return await loadImage(load)
          } catch (originalError) {
            console.warn('Failed to load original image:', originalError.message)
            return null
          }
        }
      } else {
        try {
          return await loadImage(load)
        } catch (loadError) {
          console.warn('Failed to load image:', loadError.message)
          return null
        }
      }
    } catch (error) {
      console.error('Critical error in downloadMediaImage:', error.message)
      return null
    }
  }

  hexToRgb (hex) {
    return hex.replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i
      , (m, r, g, b) => '#' + r + r + g + g + b + b)
      .substring(1).match(/.{2}/g)
      .map(x => parseInt(x, 16))
  }

  // https://codepen.io/andreaswik/pen/YjJqpK
  lightOrDark (color) {
    let r, g, b

    // Check the format of the color, HEX or RGB?
    if (color.match(/^rgb/)) {
      // If HEX --> store the red, green, blue values in separate variables
      color = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d+(?:\.\d+)?))?\)$/)

      r = color[1]
      g = color[2]
      b = color[3]
    } else {
      // If RGB --> Convert it to HEX: http://gist.github.com/983661
      color = +('0x' + color.slice(1).replace(
        color.length < 5 && /./g, '$&$&'
      )
      )

      r = color >> 16
      g = color >> 8 & 255
      b = color & 255
    }

    // HSP (Highly Sensitive Poo) equation from http://alienryderflex.com/hsp.html
    const hsp = Math.sqrt(
      0.299 * (r * r) +
      0.587 * (g * g) +
      0.114 * (b * b)
    )

    // Using the HSP value, determine whether the color is light or dark
    if (hsp > 127.5) {
      return 'light'
    } else {
      return 'dark'
    }
  }

  async drawMultilineText (text, entities, fontSize, fontColor, textX, textY, maxWidth, maxHeight, emojiBrand = 'apple') {
    if (maxWidth > 10000) maxWidth = 10000
    if (maxHeight > 10000) maxHeight = 10000

    const emojiImageJson = emojiImageByBrand[emojiBrand]

    let fallbackEmojiBrand = 'apple'
    if (emojiBrand === 'blob') fallbackEmojiBrand = 'google'

    const fallbackEmojiImageJson = emojiImageByBrand[fallbackEmojiBrand]

    // Pre-calculate text dimensions to avoid creating oversized canvas
    const canvas = createCanvas(maxWidth + fontSize, maxHeight + fontSize)
    const canvasCtx = canvas.getContext('2d')

    // text = text.slice(0, 4096)
    text = text.replace(/і/g, 'i') // замена украинской буквы і на английскую, так как она отсутствует в шрифтах Noto
    const chars = text.split('')

    const lineHeight = 4 * (fontSize * 0.3)

    const styledChar = []

    const emojis = emojiDb.searchFromText({ input: text, fixCodePoints: true })

    // Pre-load all emojis for better performance
    const emojiCache = new Map()
    const emojiLoadPromises = []

    for (let emojiIndex = 0; emojiIndex < emojis.length; emojiIndex++) {
      const emoji = emojis[emojiIndex]
      if (!emojiCache.has(emoji.found)) {
        emojiLoadPromises.push(
          (async () => {
            const emojiImageBase = emojiImageJson[emoji.found]
            if (emojiImageBase) {
              try {
                const image = await loadImage(Buffer.from(emojiImageBase, 'base64'))
                emojiCache.set(emoji.found, image)
              } catch (error) {
                try {
                  const fallbackImage = await loadImage(Buffer.from(fallbackEmojiImageJson[emoji.found], 'base64'))
                  emojiCache.set(emoji.found, fallbackImage)
                } catch (fallbackError) {
                  // Skip if both fail
                }
              }
            } else {
              try {
                const fallbackImage = await loadImage(Buffer.from(fallbackEmojiImageJson[emoji.found], 'base64'))
                emojiCache.set(emoji.found, fallbackImage)
              } catch (error) {
                // Skip if fails
              }
            }
          })()
        )
      }
    }

    // Wait for all emojis to load
    await Promise.all(emojiLoadPromises)

    for (let charIndex = 0; charIndex < chars.length; charIndex++) {
      const char = chars[charIndex]

      styledChar[charIndex] = {
        char,
        style: []
      }

      if (entities && typeof entities === 'string') styledChar[charIndex].style.push(entities)
    }

    if (entities && typeof entities === 'object') {
      for (let entityIndex = 0; entityIndex < entities.length; entityIndex++) {
        const entity = entities[entityIndex]
        const style = []

        if (['pre', 'code', 'pre_code'].includes(entity.type)) {
          style.push('monospace')
        } else if (
          ['mention', 'text_mention', 'hashtag', 'email', 'phone_number', 'bot_command', 'url', 'text_link']
            .includes(entity.type)
        ) {
          style.push('mention')
        } else {
          style.push(entity.type)
        }

        if (entity.type === 'custom_emoji') {
          styledChar[entity.offset].customEmojiId = entity.custom_emoji_id
        }

        for (let charIndex = entity.offset; charIndex < entity.offset + entity.length; charIndex++) {
          styledChar[charIndex].style = styledChar[charIndex].style.concat(style)
        }
      }
    }

    for (let emojiIndex = 0; emojiIndex < emojis.length; emojiIndex++) {
      const emoji = emojis[emojiIndex]

      for (let charIndex = emoji.offset; charIndex < emoji.offset + emoji.length; charIndex++) {
        styledChar[charIndex].emoji = {
          index: emojiIndex,
          code: emoji.found
        }
      }
    }

    const styledWords = []

    let stringNum = 0

    const breakMatch = /<br>|\n|\r/
    const spaceMatch = /[\f\n\r\t\v\u0020\u1680\u2000-\u200a\u2028\u2029\u205f\u3000]/
    const CJKMatch = /[\u1100-\u11ff\u2e80-\u2eff\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3100-\u312f\u3130-\u318f\u3190-\u319f\u31a0-\u31bf\u31c0-\u31ef\u31f0-\u31ff\u3200-\u32ff\u3300-\u33ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/

    for (let index = 0; index < styledChar.length; index++) {
      const charStyle = styledChar[index]
      const lastChar = styledChar[index - 1]

      if (
        lastChar && (
          (
            (charStyle.emoji && !lastChar.emoji) ||
              (!charStyle.emoji && lastChar.emoji) ||
              (charStyle.emoji && lastChar.emoji && charStyle.emoji.index !== lastChar.emoji.index)
          ) ||
            (
              (charStyle.char.match(breakMatch)) ||
              (charStyle.char.match(spaceMatch) && !lastChar.char.match(spaceMatch)) ||
              (lastChar.char.match(spaceMatch) && !charStyle.char.match(spaceMatch)) ||
              (charStyle.style && lastChar.style && charStyle.style.toString() !== lastChar.style.toString())
            ) || (
            charStyle.char.match(CJKMatch) ||
                lastChar.char.match(CJKMatch)
          )
        )
      ) {
        stringNum++
      }

      if (!styledWords[stringNum]) {
        styledWords[stringNum] = {
          word: charStyle.char
        }

        if (charStyle.style) styledWords[stringNum].style = charStyle.style
        if (charStyle.emoji) styledWords[stringNum].emoji = charStyle.emoji
        if (charStyle.customEmojiId) styledWords[stringNum].customEmojiId = charStyle.customEmojiId
      } else styledWords[stringNum].word += charStyle.char
    }

    let lineX = textX
    let lineY = textY

    let textWidth = 0

    // load custom emoji
    const customEmojiIds = []

    for (let index = 0; index < styledWords.length; index++) {
      const word = styledWords[index]

      if (word.customEmojiId) {
        customEmojiIds.push(word.customEmojiId)
      }
    }

    const getCustomEmojiStickers = await this.telegram.callApi('getCustomEmojiStickers', {
      custom_emoji_ids: customEmojiIds
    }).catch(() => {})

    const customEmojiStickers = {}

    const loadCustomEmojiStickerPromises = []

    if (getCustomEmojiStickers) {
      for (let index = 0; index < getCustomEmojiStickers.length; index++) {
        const sticker = getCustomEmojiStickers[index]

        loadCustomEmojiStickerPromises.push((async () => {
          const getFileLink = await this.telegram.getFileLink(sticker.thumb.file_id).catch(() => {})

          if (getFileLink) {
            const load = await loadImageFromUrl(getFileLink).catch(() => {})
            const imageSharp = sharp(load)
            const sharpPng = await imageSharp.png({ lossless: true, force: true }).toBuffer()

            customEmojiStickers[sticker.custom_emoji_id] = await loadImage(sharpPng).catch(() => {})
          }
        })())
      }

      await Promise.all(loadCustomEmojiStickerPromises).catch(() => {})
    }

    let breakWrite = false
    let lineDirection = this.getLineDirection(styledWords, 0)

    // Pre-set font to avoid repeated font changes
    let currentFont = null
    let currentFillStyle = null

    for (let index = 0; index < styledWords.length; index++) {
      const styledWord = styledWords[index]

      let emojiImage

      if (styledWord.emoji) {
        if (styledWord.customEmojiId && customEmojiStickers[styledWord.customEmojiId]) {
          emojiImage = customEmojiStickers[styledWord.customEmojiId]
        } else {
          // Use pre-loaded emoji from cache
          emojiImage = emojiCache.get(styledWord.emoji.code)
        }
      }

      let fontType = ''
      let fontName = 'NotoSans'
      let fillStyle = fontColor

      if (styledWord.style.includes('bold')) {
        fontType += 'bold '
      }
      if (styledWord.style.includes('italic')) {
        fontType += 'italic '
      }
      if (styledWord.style.includes('monospace')) {
        fontName = 'NotoSansMono'
        fillStyle = '#5887a7'
      }
      if (styledWord.style.includes('mention')) {
        fillStyle = '#6ab7ec'
      }
      if (styledWord.style.includes('spoiler')) {
        const rbaColor = this.hexToRgb(this.normalizeColor(fontColor))
        fillStyle = `rgba(${rbaColor[0]}, ${rbaColor[1]}, ${rbaColor[2]}, 0.15)`
      }

      const newFont = `${fontType} ${fontSize}px ${fontName}`

      // Only change font if different from current
      if (currentFont !== newFont) {
        canvasCtx.font = newFont
        currentFont = newFont
      }

      // Only change fill style if different from current
      if (currentFillStyle !== fillStyle) {
        canvasCtx.fillStyle = fillStyle
        currentFillStyle = fillStyle
      }

      // Pre-truncate long words before measurement
      let wordToMeasure = styledWord.word
      const maxWordWidth = maxWidth - fontSize * 3

      if (wordToMeasure.length > 50) { // Quick length check before expensive measurement
        while (canvasCtx.measureText(wordToMeasure).width > maxWordWidth && wordToMeasure.length > 0) {
          wordToMeasure = wordToMeasure.substr(0, wordToMeasure.length - 1)
        }
        if (wordToMeasure.length < styledWord.word.length) {
          styledWord.word = wordToMeasure + '…'
        }
      } else if (canvasCtx.measureText(wordToMeasure).width > maxWordWidth) {
        while (canvasCtx.measureText(wordToMeasure).width > maxWordWidth && wordToMeasure.length > 0) {
          wordToMeasure = wordToMeasure.substr(0, wordToMeasure.length - 1)
        }
        styledWord.word = wordToMeasure + '…'
      }

      let lineWidth
      const wordlWidth = canvasCtx.measureText(styledWord.word).width

      if (styledWord.emoji) lineWidth = lineX + fontSize
      else lineWidth = lineX + wordlWidth

      if (styledWord.word.match(breakMatch) || (lineWidth > maxWidth - fontSize * 2 && wordlWidth < maxWidth)) {
        if (styledWord.word.match(spaceMatch) && !styledWord.word.match(breakMatch)) styledWord.word = ''
        if ((styledWord.word.match(spaceMatch) || !styledWord.word.match(breakMatch)) && lineY + lineHeight > maxHeight) {
          while (lineWidth > maxWidth - fontSize * 2) {
            styledWord.word = styledWord.word.substr(0, styledWord.word.length - 1)
            lineWidth = lineX + canvasCtx.measureText(styledWord.word).width
            if (styledWord.word.length <= 0) break
          }

          styledWord.word += '…'
          lineWidth = lineX + canvasCtx.measureText(styledWord.word).width
          breakWrite = true
        } else {
          if (styledWord.emoji) lineWidth = textX + fontSize + (fontSize * 0.2)
          else lineWidth = textX + canvasCtx.measureText(styledWord.word).width

          lineX = textX
          lineY += lineHeight
          if (index < styledWords.length - 1) {
            let nextLineDirection = this.getLineDirection(styledWords, index + 1)
            if (lineDirection !== nextLineDirection) textWidth = maxWidth - fontSize * 2
            lineDirection = nextLineDirection
          }
        }
      }

      if (styledWord.emoji) lineWidth += (fontSize * 0.2)

      if (lineWidth > textWidth) textWidth = lineWidth
      if (textWidth > maxWidth) textWidth = maxWidth

      let wordX = (lineDirection === 'rtl') ? maxWidth - lineX - wordlWidth - fontSize * 2 : lineX

      if (emojiImage) {
        canvasCtx.drawImage(emojiImage, wordX, lineY - fontSize + (fontSize * 0.15), fontSize + (fontSize * 0.22), fontSize + (fontSize * 0.22))
      } else {
        canvasCtx.fillText(styledWord.word, wordX, lineY)

        if (styledWord.style.includes('strikethrough')) canvasCtx.fillRect(wordX, lineY - fontSize / 2.8, canvasCtx.measureText(styledWord.word).width, fontSize * 0.1)
        if (styledWord.style.includes('underline')) canvasCtx.fillRect(wordX, lineY + 2, canvasCtx.measureText(styledWord.word).width, fontSize * 0.1)
      }

      lineX = lineWidth

      if (breakWrite) break
    }

    const canvasResize = createCanvas(textWidth, lineY + fontSize)
    const canvasResizeCtx = canvasResize.getContext('2d')

    let dx = (lineDirection === 'rtl') ? textWidth - maxWidth + fontSize * 2 : 0
    canvasResizeCtx.drawImage(canvas, dx, 0)

    return canvasResize
  }

  // https://stackoverflow.com/a/3368118
  drawRoundRect (color, w, h, r) {
    const x = 0
    const y = 0

    const canvas = createCanvas(w, h)
    const canvasCtx = canvas.getContext('2d')

    canvasCtx.fillStyle = color

    if (w < 2 * r) r = w / 2
    if (h < 2 * r) r = h / 2
    canvasCtx.beginPath()
    canvasCtx.moveTo(x + r, y)
    canvasCtx.arcTo(x + w, y, x + w, y + h, r)
    canvasCtx.arcTo(x + w, y + h, x, y + h, r)
    canvasCtx.arcTo(x, y + h, x, y, r)
    canvasCtx.arcTo(x, y, x + w, y, r)
    canvasCtx.closePath()

    canvasCtx.fill()

    return canvas
  }

  drawGradientRoundRect (colorOne, colorTwo, w, h, r) {
    const x = 0
    const y = 0

    const canvas = createCanvas(w, h)
    const canvasCtx = canvas.getContext('2d')

    const gradient = canvasCtx.createLinearGradient(0, 0, w, h)
    gradient.addColorStop(0, colorOne)
    gradient.addColorStop(1, colorTwo)

    canvasCtx.fillStyle = gradient

    if (w < 2 * r) r = w / 2
    if (h < 2 * r) r = h / 2
    canvasCtx.beginPath()
    canvasCtx.moveTo(x + r, y)
    canvasCtx.arcTo(x + w, y, x + w, y + h, r)
    canvasCtx.arcTo(x + w, y + h, x, y + h, r)
    canvasCtx.arcTo(x, y + h, x, y, r)
    canvasCtx.arcTo(x, y, x + w, y, r)
    canvasCtx.closePath()

    canvasCtx.fill()

    return canvas
  }

  colorLuminance (hex, lum) {
    hex = String(hex).replace(/[^0-9a-f]/gi, '')
    if (hex.length < 6) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
    }
    lum = lum || 0

    // convert to decimal and change luminosity
    let rgb = '#'
    let c
    let i
    for (i = 0; i < 3; i++) {
      c = parseInt(hex.substr(i * 2, 2), 16)
      c = Math.round(Math.min(Math.max(0, c + (c * lum)), 255)).toString(16)
      rgb += ('00' + c).substr(c.length)
    }

    return rgb
  }

  roundImage (image, r) {
    const w = image.width
    const h = image.height

    const canvas = createCanvas(w, h)
    const canvasCtx = canvas.getContext('2d')

    const x = 0
    const y = 0

    if (w < 2 * r) r = w / 2
    if (h < 2 * r) r = h / 2
    canvasCtx.beginPath()
    canvasCtx.moveTo(x + r, y)
    canvasCtx.arcTo(x + w, y, x + w, y + h, r)
    canvasCtx.arcTo(x + w, y + h, x, y + h, r)
    canvasCtx.arcTo(x, y + h, x, y, r)
    canvasCtx.arcTo(x, y, x + w, y, r)
    canvasCtx.save()
    canvasCtx.clip()
    canvasCtx.closePath()
    canvasCtx.drawImage(image, x, y)
    canvasCtx.restore()

    return canvas
  }

  drawReplyLine (lineWidth, height, color) {
    const canvas = createCanvas(20, height)
    const context = canvas.getContext('2d')
    context.beginPath()
    context.moveTo(10, 0)
    context.lineTo(10, height)
    context.lineWidth = lineWidth
    context.strokeStyle = color
    context.stroke()
    context.closePath()

    return canvas
  }

  async drawAvatar (user) {
    try {
      const avatarImage = await this.downloadAvatarImage(user)

      if (avatarImage) {
        const avatarSize = avatarImage.naturalHeight || avatarImage.height

        const canvas = createCanvas(avatarSize, avatarSize)
        const canvasCtx = canvas.getContext('2d')

        const avatarX = 0
        const avatarY = 0

        canvasCtx.beginPath()
        canvasCtx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2, true)
        canvasCtx.clip()
        canvasCtx.closePath()
        canvasCtx.restore()
        canvasCtx.drawImage(avatarImage, avatarX, avatarY, avatarSize, avatarSize)

        return canvas
      } else {
        console.warn('No avatar image available for user')
        return null
      }
    } catch (error) {
      console.warn('Error drawing avatar:', error.message)
      return null
    }
  }

  drawLineSegment (ctx, x, y, width, isEven) {
    ctx.lineWidth = 35 // how thick the line is
    ctx.strokeStyle = '#aec6cf' // what color our line is
    ctx.beginPath()
    y = isEven ? y : -y
    ctx.moveTo(x, 0)
    ctx.lineTo(x, y)
    ctx.arc(x + width / 2, y, width / 2, Math.PI, 0, isEven)
    ctx.lineTo(x + width, 0)
    ctx.stroke()
  }

  drawWaveform (data) {
    const normalizedData = data.map(i => i / 32)

    const canvas = createCanvas(4500, 500)
    const padding = 50
    canvas.height = (canvas.height + padding * 2)
    const ctx = canvas.getContext('2d')
    ctx.translate(0, canvas.height / 2 + padding)

    // draw the line segments
    const width = canvas.width / normalizedData.length
    for (let i = 0; i < normalizedData.length; i++) {
      const x = width * i
      let height = normalizedData[i] * canvas.height - padding
      if (height < 0) {
        height = 0
      } else if (height > canvas.height / 2) {
        height = height > canvas.height / 2
      }
      this.drawLineSegment(ctx, x, height, width, (i + 1) % 2)
    }
    return canvas
  }

  async drawQuote (scale = 1, backgroundColorOne, backgroundColorTwo, avatar, replyName, replyNameColor, replyText, name, text, media, mediaType, maxMediaSize) {
    const avatarPosX = 0 * scale
    const avatarPosY = 5 * scale
    const avatarSize = 50 * scale

    const blockPosX = avatarSize + 10 * scale
    const blockPosY = 0

    const indent = 14 * scale

    if (mediaType === 'sticker') name = undefined

    let width = 0
    if (name) width = name.width
    if (text && width < text.width + indent) width = text.width + indent
    if (name && width < name.width + indent) width = name.width + indent
    if (replyName) {
      if (width < replyName.width) width = replyName.width + indent * 2
      if (replyText && width < replyText.width) width = replyText.width + indent * 2
    }

    let height = indent
    if (text) height += text.height
    else height += indent

    if (name) {
      height = name.height
      if (text) height = text.height + name.height
      else height += indent
    }

    width += blockPosX + indent
    height += blockPosY

    let namePosX = blockPosX + indent
    let namePosY = indent

    if (!name) {
      namePosX = 0
      namePosY = -indent
    }

    const textPosX = blockPosX + indent
    let textPosY = indent
    if (name) {
      textPosY = name.height + indent * 0.25
      height += indent * 0.25
    }

    let replyPosX = 0
    let replyNamePosY = 0
    let replyTextPosY = 0

    if (replyName && replyText) {
      replyPosX = textPosX + indent

      const replyNameHeight = replyName.height
      const replyTextHeight = replyText.height * 0.5

      replyNamePosY = namePosY + replyNameHeight
      replyTextPosY = replyNamePosY + replyTextHeight

      textPosY += replyNameHeight + replyTextHeight + (indent / 4)
      height += replyNameHeight + replyTextHeight + (indent / 4)
    }

    let mediaPosX = 0
    let mediaPosY = 0

    let mediaWidth, mediaHeight

    if (media) {
      mediaWidth = media.width * (maxMediaSize / media.height)
      mediaHeight = maxMediaSize

      if (mediaWidth >= maxMediaSize) {
        mediaWidth = maxMediaSize
        mediaHeight = media.height * (maxMediaSize / media.width)
      }

      if (!text || text.width <= mediaWidth || mediaWidth > (width - blockPosX)) {
        width = mediaWidth + indent * 6
      }

      height += mediaHeight
      if (!text) height += indent

      if (name) {
        mediaPosX = namePosX
        mediaPosY = name.height + 5 * scale
      } else {
        mediaPosX = blockPosX + indent
        mediaPosY = indent
      }
      if (replyName) mediaPosY += replyNamePosY + indent / 2
      textPosY = mediaPosY + mediaHeight + 5 * scale
    }

    // Declare rectWidth and rectHeight variables before using them
    let rectWidth = width - blockPosX
    let rectHeight = height

    if (mediaType === 'sticker' && (name || replyName)) {
      rectHeight = replyName && replyText ? (replyName.height + replyText.height * 0.5) + indent * 2 : indent * 2
      backgroundColorOne = backgroundColorTwo = 'rgba(0, 0, 0, 0.5)'
    }

    const canvas = createCanvas(width, height)
    const canvasCtx = canvas.getContext('2d')

    const rectPosX = blockPosX
    const rectPosY = blockPosY
    const rectRoundRadius = 25 * scale

    let rect
    if (mediaType === 'sticker' && (name || replyName)) {
      rectHeight = (replyName.height + replyText.height * 0.5) + indent * 2
      backgroundColorOne = backgroundColorTwo = 'rgba(0, 0, 0, 0.5)'
    }

    if (mediaType !== 'sticker' || name || replyName) {
      if (backgroundColorOne === backgroundColorTwo) {
        rect = this.drawRoundRect(backgroundColorOne, rectWidth, rectHeight, rectRoundRadius)
      } else {
        rect = this.drawGradientRoundRect(backgroundColorOne, backgroundColorTwo, rectWidth, rectHeight, rectRoundRadius)
      }
    }

    if (avatar) canvasCtx.drawImage(avatar, avatarPosX, avatarPosY, avatarSize, avatarSize)
    if (rect) canvasCtx.drawImage(rect, rectPosX, rectPosY)
    if (name) canvasCtx.drawImage(name, namePosX, namePosY)
    if (text) canvasCtx.drawImage(text, textPosX, textPosY)
    if (media) canvasCtx.drawImage(this.roundImage(media, 5 * scale), mediaPosX, mediaPosY, mediaWidth, mediaHeight)

    if (replyName && replyText) {
      canvasCtx.drawImage(this.drawReplyLine(3 * scale, replyName.height + replyText.height * 0.4, replyNameColor), textPosX - 3, replyNamePosY)

      canvasCtx.drawImage(replyName, replyPosX, replyNamePosY)
      canvasCtx.drawImage(replyText, replyPosX, replyTextPosY)
    }

    return canvas
  }

  normalizeColor (color) {
    const canvas = createCanvas(0, 0)
    const canvasCtx = canvas.getContext('2d')

    canvasCtx.fillStyle = color
    color = canvasCtx.fillStyle

    return color
  }

  getLineDirection (words, startIndex) {
    const RTLMatch = /[\u0591-\u07FF\u200F\u202B\u202E\uFB1D-\uFDFD\uFE70-\uFEFC]/
    const neutralMatch = /[\u0001-\u0040\u005B-\u0060\u007B-\u00BF\u00D7\u00F7\u02B9-\u02FF\u2000-\u2BFF\u2010-\u2029\u202C\u202F-\u2BFF\u1F300-\u1F5FF\u1F600-\u1F64F]/

    for (let index = startIndex; index < words.length; index++) {
      if (words[index].word.match(RTLMatch)) {
        return 'rtl'
      } else {
        if (!words[index].word.match(neutralMatch)) { return 'ltr' }
      }
    }
    return 'ltr'
  }

  async generate (backgroundColorOne, backgroundColorTwo, message, width = 512, height = 512, scale = 2, emojiBrand = 'apple') {
    if (!scale) scale = 2
    if (scale > 20) scale = 20
    width = width || 512 // Ensure width has a default value
    height = height || 512 // Ensure height has a default value
    width *= scale
    height *= scale

    // check background style color black/light
    const backStyle = this.lightOrDark(backgroundColorOne)

    // historyPeer1NameFg: #c03d33; // red
    // historyPeer2NameFg: #4fad2d; // green
    // historyPeer3NameFg: #d09306; // yellow
    // historyPeer4NameFg: #168acd; // blue
    // historyPeer5NameFg: #8544d6; // purple
    // historyPeer6NameFg: #cd4073; // pink
    // historyPeer7NameFg: #2996ad; // sea
    // historyPeer8NameFg: #ce671b; // orange

    // { 0, 7, 4, 1, 6, 3, 5 }
    // const nameColor = [
    //   '#c03d33', // red
    //   '#ce671b', // orange
    //   '#8544d6', // purple
    //   '#4fad2d', // green
    //   '#2996ad', // sea
    //   '#168acd', // blue
    //   '#cd4073' // pink
    // ]

    const nameColorLight = [
      '#FC5C51', // red
      '#FA790F', // orange
      '#895DD5', // purple
      '#0FB297', // green
      '#0FC9D6', // sea
      '#3CA5EC', // blue
      '#D54FAF' // pink
    ]

    const nameColorDark = [
      '#FF8E86', // red
      '#FFA357', // orange
      '#B18FFF', // purple
      '#4DD6BF', // green
      '#45E8D1', // sea
      '#7AC9FF', // blue
      '#FF7FD5' // pink
    ]

    // user name  color
    let nameIndex = 1
    if (message.from && message.from.id) nameIndex = Math.abs(message.from.id) % 7

    const nameColorArray = backStyle === 'light' ? nameColorLight : nameColorDark

    let nameColor = nameColorArray[nameIndex]

    const colorContrast = new ColorContrast()

    // change name color based on background color by contrast
    const contrast = colorContrast.getContrastRatio(this.colorLuminance(backgroundColorOne, 0.55), nameColor)
    if (contrast > 90 || contrast < 30) {
      nameColor = colorContrast.adjustContrast(this.colorLuminance(backgroundColorTwo, 0.55), nameColor)
    }

    const nameSize = 22 * scale

    let nameCanvas
    if ((message.from && message.from.name) || (message.from && (message.from.first_name || message.from.last_name))) {
      let name = message.from.name || `${message.from.first_name || ''} ${message.from.last_name || ''}`.trim()

      if (!name) name = 'User' // Default name if none provided

      const nameEntities = [
        {
          type: 'bold',
          offset: 0,
          length: name.length
        }
      ]

      if (message.from.emoji_status) {
        name += ' 🤡'

        nameEntities.push({
          type: 'custom_emoji',
          offset: name.length - 2,
          length: 2,
          custom_emoji_id: message.from.emoji_status
        })
      }

      nameCanvas = await this.drawMultilineText(
        name,
        nameEntities,
        nameSize,
        nameColor,
        0,
        nameSize,
        width,
        nameSize,
        emojiBrand
      )
    }

    let fontSize = 24 * scale

    let textColor = '#fff'
    if (backStyle === 'light') textColor = '#000'

    let textCanvas
    if (message.text) {
      textCanvas = await this.drawMultilineText(
        message.text,
        message.entities,
        fontSize,
        textColor,
        0,
        fontSize,
        width,
        height - fontSize,
        emojiBrand
      )
    }

    let avatarCanvas
    if (message.avatar && message.from) {
      try {
        avatarCanvas = await this.drawAvatar(message.from)
      } catch (error) {
        console.warn('Error drawing avatar:', error.message)
        avatarCanvas = null
      }
    }

    let replyName, replyNameColor, replyText
    if (message.replyMessage && message.replyMessage.name && message.replyMessage.text) {
      try {
        // Ensure chatId exists to prevent NaN in calculations
        const chatId = message.replyMessage.chatId || 0
        const replyNameIndex = Math.abs(chatId) % 7
        replyNameColor = nameColorArray[replyNameIndex]

        const replyNameFontSize = 16 * scale
        replyName = await this.drawMultilineText(
          message.replyMessage.name,
          'bold',
          replyNameFontSize,
          replyNameColor,
          0,
          replyNameFontSize,
          width * 0.9,
          replyNameFontSize,
          emojiBrand
        )

        let textColor = '#fff'
        if (backStyle === 'light') textColor = '#000'

        const replyTextFontSize = 21 * scale
        replyText = await this.drawMultilineText(
          message.replyMessage.text,
          message.replyMessage.entities || [],
          replyTextFontSize,
          textColor,
          0,
          replyTextFontSize,
          width * 0.9,
          replyTextFontSize,
          emojiBrand
        )
      } catch (error) {
        console.error('Error generating reply message:', error)
        // If reply message generation fails, continue without it
        replyName = null
        replyText = null
      }
    }

    let mediaCanvas, mediaType, maxMediaSize
    if (message.media) {
      let media, type

      let crop = false
      if (message.mediaCrop) crop = true

      if (message.media.url) {
        type = 'url'
        media = message.media.url
      } else {
        type = 'id'
        if (message.media.length > 1) {
          if (crop) media = message.media[1]
          else media = message.media.pop()
        } else media = message.media[0]
      }

      maxMediaSize = width / 3 * scale
      if (message.text && textCanvas && maxMediaSize < textCanvas.width) maxMediaSize = textCanvas.width

      if (media && media.is_animated) {
        media = media.thumb
        maxMediaSize = maxMediaSize / 2
      }

      try {
        mediaCanvas = await this.downloadMediaImage(media, maxMediaSize, type, crop)
        if (mediaCanvas) {
          mediaType = message.mediaType
        } else {
          console.warn('Failed to download media image, skipping media for this message')
          mediaCanvas = null
          mediaType = null
        }
      } catch (error) {
        console.warn('Error downloading media image:', error.message)
        mediaCanvas = null
        mediaType = null
      }
    }

    if (message.voice) {
      mediaCanvas = this.drawWaveform(message.voice.waveform)
      maxMediaSize = width / 3 * scale
    }

    const quote = this.drawQuote(
      scale,
      backgroundColorOne, backgroundColorTwo,
      avatarCanvas,
      replyName, replyNameColor, replyText,
      nameCanvas, textCanvas,
      mediaCanvas, mediaType, maxMediaSize
    )

    return quote
  }
}

module.exports = QuoteGenerate
