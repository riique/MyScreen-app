use windows::core::{Error, Interface, Result};
use windows::Win32::{
    Foundation::E_FAIL,
    Graphics::{
        Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
        Direct3D11::*,
        Dxgi::{Common::*, *},
    },
};
use windows_sys::Win32::Foundation::RECT;

pub struct Capture {
    source: IDXGIOutputDuplication,
    context: ID3D11DeviceContext,
    staging: ID3D11Texture2D,
    crop: D3D11_BOX,
    rotation: DXGI_MODE_ROTATION,
    width: u16,
    height: u16,
    rgba: Vec<u8>,
}

impl Capture {
    pub fn new(rect: RECT) -> Result<Self> {
        unsafe {
            let factory = CreateDXGIFactory1::<IDXGIFactory1>()?;
            for index in 0.. {
                let Ok(adapter) = factory.EnumAdapters1(index) else {
                    break;
                };
                for index in 0.. {
                    let Ok(output) = adapter.EnumOutputs(index) else {
                        break;
                    };
                    let info = output.GetDesc()?;
                    let bounds = info.DesktopCoordinates;
                    if !info.AttachedToDesktop.as_bool()
                        || rect.left < bounds.left
                        || rect.right > bounds.right
                        || rect.top < bounds.top
                        || rect.bottom > bounds.bottom
                    {
                        continue;
                    }
                    let (mut device, mut context) = (None, None);
                    D3D11CreateDevice(
                        &adapter,
                        D3D_DRIVER_TYPE_UNKNOWN,
                        Default::default(),
                        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                        None,
                        D3D11_SDK_VERSION,
                        Some(&mut device),
                        None,
                        Some(&mut context),
                    )?;
                    let device = device.ok_or_else(|| Error::from_hresult(E_FAIL))?;
                    let context = context.ok_or_else(|| Error::from_hresult(E_FAIL))?;
                    let source = output.cast::<IDXGIOutput1>()?.DuplicateOutput(&device)?;
                    let w = (bounds.right - bounds.left) as u32;
                    let h = (bounds.bottom - bounds.top) as u32;
                    let (l, t, r, b) = (
                        (rect.left - bounds.left) as u32,
                        (rect.top - bounds.top) as u32,
                        (rect.right - bounds.left) as u32,
                        (rect.bottom - bounds.top) as u32,
                    );
                    let (left, top, right, bottom) = match info.Rotation {
                        DXGI_MODE_ROTATION_ROTATE90 => (t, w - r, b, w - l),
                        DXGI_MODE_ROTATION_ROTATE180 => (w - r, h - b, w - l, h - t),
                        DXGI_MODE_ROTATION_ROTATE270 => (h - b, l, h - t, r),
                        _ => (l, t, r, b),
                    };
                    let crop = D3D11_BOX {
                        left,
                        top,
                        right,
                        bottom,
                        front: 0,
                        back: 1,
                    };
                    let desc = D3D11_TEXTURE2D_DESC {
                        Width: right - left,
                        Height: bottom - top,
                        MipLevels: 1,
                        ArraySize: 1,
                        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                        SampleDesc: DXGI_SAMPLE_DESC {
                            Count: 1,
                            Quality: 0,
                        },
                        Usage: D3D11_USAGE_STAGING,
                        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                        ..Default::default()
                    };
                    let mut staging = None;
                    device.CreateTexture2D(&desc, None, Some(&mut staging))?;
                    let staging = staging.ok_or_else(|| Error::from_hresult(E_FAIL))?;
                    let divisor = (r - l).div_ceil(1024).max((b - t).div_ceil(768)).max(1);
                    let width = ((r - l) / divisor).max(1) as u16;
                    let height = ((b - t) / divisor).max(1) as u16;
                    return Ok(Self {
                        source,
                        context,
                        staging,
                        crop,
                        rotation: info.Rotation,
                        width,
                        height,
                        rgba: vec![0; usize::from(width) * usize::from(height) * 4],
                    });
                }
            }
            Err(Error::from_hresult(E_FAIL))
        }
    }

    pub fn frame(&mut self) -> Result<Option<(u16, u16, &[u8])>> {
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut image = None;
            match self.source.AcquireNextFrame(0, &mut info, &mut image) {
                Err(error) if error.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(None),
                result => result?,
            }
            let converted = self.convert(image, info.ProtectedContentMaskedOut.as_bool());
            let released = self.source.ReleaseFrame();
            converted?;
            released?;
            Ok(Some((self.width, self.height, &self.rgba)))
        }
    }

    unsafe fn convert(&mut self, image: Option<IDXGIResource>, masked: bool) -> Result<()> {
        let texture = image
            .ok_or_else(|| Error::from_hresult(E_FAIL))?
            .cast::<ID3D11Texture2D>()?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);
        if masked
            || desc.Width < self.crop.right
            || desc.Height < self.crop.bottom
            || desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
        {
            return Err(Error::from_hresult(E_FAIL));
        }
        self.context.CopySubresourceRegion(
            &self.staging,
            0,
            0,
            0,
            0,
            &texture,
            0,
            Some(&self.crop),
        );
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        self.context
            .Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        let pitch = mapped.RowPitch as usize;
        let width = (self.crop.right - self.crop.left) as usize;
        let height = (self.crop.bottom - self.crop.top) as usize;
        let target_width = self.width as usize;
        let target_height = self.height as usize;
        let pixels = std::slice::from_raw_parts(mapped.pData.cast::<u8>(), pitch * height);
        for (i, out) in self.rgba.chunks_exact_mut(4).enumerate() {
            let x = i % target_width;
            let y = i / target_width;
            let (x, y) = match self.rotation {
                DXGI_MODE_ROTATION_ROTATE90 => (
                    y * width / target_height,
                    height - 1 - x * height / target_width,
                ),
                DXGI_MODE_ROTATION_ROTATE180 => (
                    width - 1 - x * width / target_width,
                    height - 1 - y * height / target_height,
                ),
                DXGI_MODE_ROTATION_ROTATE270 => (
                    width - 1 - y * width / target_height,
                    x * height / target_width,
                ),
                _ => (x * width / target_width, y * height / target_height),
            };
            let offset = y * pitch + x * 4;
            out.copy_from_slice(&[pixels[offset + 2], pixels[offset + 1], pixels[offset], 255]);
        }
        self.context.Unmap(&self.staging, 0);
        Ok(())
    }
}
