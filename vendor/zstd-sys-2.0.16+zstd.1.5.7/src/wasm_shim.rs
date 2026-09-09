use alloc::alloc::{Layout, alloc, alloc_zeroed, dealloc};
use core::ffi::{c_int, c_void};

// Preserve malloc alignment for every wasm32 C scalar, including 128-bit values.
const ALLOCATION_ALIGN: usize = 16;
const HEADER_SIZE: usize = ALLOCATION_ALIGN;

#[no_mangle]
pub unsafe extern "C" fn rust_zstd_wasm_shim_qsort(
    base: *mut c_void,
    n_items: usize,
    size: usize,
    compar: extern "C" fn(*const c_void, *const c_void) -> c_int,
) {
    if n_items == 0 {
        return;
    }
    unsafe {
        match size {
            1 => qsort::<1>(base, n_items, compar),
            2 => qsort::<2>(base, n_items, compar),
            4 => qsort::<4>(base, n_items, compar),
            8 => qsort::<8>(base, n_items, compar),
            16 => qsort::<16>(base, n_items, compar),
            _ => panic!("Unsupported qsort item size"),
        }
    }
}

unsafe fn qsort<const N: usize>(
    base: *mut c_void,
    n_items: usize,
    compar: extern "C" fn(*const c_void, *const c_void) -> c_int,
) {
    #[repr(align(16))]
    struct ComparatorItem<const N: usize>([core::mem::MaybeUninit<u8>; N]);
    // C structures can contain uninitialized padding. Copy their representation
    // without materializing padding as initialized Rust bytes.
    let base = core::slice::from_raw_parts_mut(
        base.cast::<[core::mem::MaybeUninit<u8>; N]>(), n_items);
    base.sort_unstable_by(|a, b| {
        // Sort may compare alignment-1 byte-array temporaries. Aligned copies
        // satisfy C comparators without imposing alignment on packed input.
        let a = ComparatorItem(*a);
        let b = ComparatorItem(*b);
        match compar(a.0.as_ptr().cast(), b.0.as_ptr().cast()) {
            ..=-1 => core::cmp::Ordering::Less,
            0 => core::cmp::Ordering::Equal,
            1.. => core::cmp::Ordering::Greater,
        }
    });
}

#[no_mangle]
pub extern "C" fn rust_zstd_wasm_shim_malloc(size: usize) -> *mut c_void {
    wasm_shim_alloc::<false>(size)
}

#[no_mangle]
pub unsafe extern "C" fn rust_zstd_wasm_shim_memcmp(
    str1: *const c_void,
    str2: *const c_void,
    n: usize,
) -> i32 {
    if n == 0 {
        return 0;
    }
    // Safety: function contracts requires str1 and str2 at least `n`-long.
    unsafe {
        let str1: &[u8] = core::slice::from_raw_parts(str1 as *const u8, n);
        let str2: &[u8] = core::slice::from_raw_parts(str2 as *const u8, n);
        match str1.cmp(str2) {
            core::cmp::Ordering::Less => -1,
            core::cmp::Ordering::Equal => 0,
            core::cmp::Ordering::Greater => 1,
        }
    }
}

#[no_mangle]
pub extern "C" fn rust_zstd_wasm_shim_calloc(nmemb: usize, size: usize) -> *mut c_void {
    // note: calloc expects the allocation to be zeroed
    match nmemb.checked_mul(size) {
        Some(bytes) => wasm_shim_alloc::<true>(bytes),
        None => core::ptr::null_mut(),
    }
}

#[inline]
fn wasm_shim_alloc<const ZEROED: bool>(size: usize) -> *mut c_void {
    // in order to recover the size upon free, we store the size below the allocation
    // special alignment is never requested via the malloc API,
    // so it is not stored; the payload and header both use malloc alignment
    // memory layout: [size] [allocation]

    let Some(full_alloc_size) = size.checked_add(HEADER_SIZE) else {
        return core::ptr::null_mut();
    };
    let Ok(layout) = Layout::from_size_align(full_alloc_size, ALLOCATION_ALIGN) else {
        return core::ptr::null_mut();
    };

    unsafe {
        let ptr = if ZEROED {
            alloc_zeroed(layout)
        } else {
            alloc(layout)
        };

        if ptr.is_null() {
            return core::ptr::null_mut();
        }

        // SAFETY: the non-null allocation is aligned and includes the size header.
        ptr.cast::<usize>().write(full_alloc_size);

        ptr.add(HEADER_SIZE).cast()
    }
}

#[no_mangle]
pub unsafe extern "C" fn rust_zstd_wasm_shim_free(ptr: *mut c_void) {
    // the layout for the allocation needs to be recovered for dealloc
    // - the size must be recovered from directly below the allocation
    // - the alignment will always by ALLOCATION_ALIGN

    if ptr.is_null() {
        return;
    }
    let alloc_ptr = ptr.sub(HEADER_SIZE);
    // SAFETY: the allocation routines must uphold having a valid usize below the provided pointer
    let full_alloc_size = alloc_ptr.cast::<usize>().read();

    let layout = Layout::from_size_align_unchecked(full_alloc_size, ALLOCATION_ALIGN);
    dealloc(alloc_ptr.cast(), layout);
}

#[no_mangle]
pub unsafe extern "C" fn rust_zstd_wasm_shim_memcpy(
    dest: *mut c_void,
    src: *const c_void,
    n: usize,
) -> *mut c_void {
    if n == 0 {
        return dest;
    }
    core::ptr::copy_nonoverlapping(src as *const u8, dest as *mut u8, n);
    dest
}

#[no_mangle]
pub unsafe extern "C" fn rust_zstd_wasm_shim_memmove(
    dest: *mut c_void,
    src: *const c_void,
    n: usize,
) -> *mut c_void {
    if n == 0 {
        return dest;
    }
    core::ptr::copy(src as *const u8, dest as *mut u8, n);
    dest
}

#[no_mangle]
pub unsafe extern "C" fn rust_zstd_wasm_shim_memset(
    dest: *mut c_void,
    c: c_int,
    n: usize,
) -> *mut c_void {
    if n == 0 {
        return dest;
    }
    core::ptr::write_bytes(dest as *mut u8, c as u8, n);
    dest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qsort_comparator_receives_aligned_values_from_unaligned_storage() {
        use core::sync::atomic::{AtomicBool, Ordering};
        static ALIGNED: AtomicBool = AtomicBool::new(true);
        extern "C" fn compare(a: *const c_void, b: *const c_void) -> c_int {
            if a as usize % 16 != 0 || b as usize % 16 != 0 {
                ALIGNED.store(false, Ordering::Relaxed);
            }
            // Keep this regression safe even if comparator alignment fails.
            let (a, b) = unsafe {
                (
                    a.cast::<u64>().read_unaligned(),
                    b.cast::<u64>().read_unaligned(),
                )
            };
            match a.cmp(&b) {
                core::cmp::Ordering::Less => -1,
                core::cmp::Ordering::Equal => 0,
                core::cmp::Ordering::Greater => 1,
            }
        }
        let mut storage = [0u8; 33];
        for (chunk, value) in storage[1..].chunks_exact_mut(8).zip([9u64, 1, 5, 2]) {
            chunk.copy_from_slice(&value.to_ne_bytes());
        }
        unsafe { rust_zstd_wasm_shim_qsort(storage.as_mut_ptr().add(1).cast(), 4, 8, compare) };
        assert!(ALIGNED.load(Ordering::Relaxed));
        for (chunk, value) in storage[1..].chunks_exact(8).zip([1u64, 2, 5, 9]) {
            assert_eq!(chunk, value.to_ne_bytes());
        }
    }

    #[test]
    fn allocation_overflow_returns_null() {
        assert!(rust_zstd_wasm_shim_malloc(usize::MAX).is_null());
        assert!(rust_zstd_wasm_shim_calloc(usize::MAX, 2).is_null());
        assert!(rust_zstd_wasm_shim_malloc(isize::MAX as usize).is_null());
    }

    #[test]
    fn calloc_is_zeroed_aligned_and_free_accepts_null() {
        unsafe { rust_zstd_wasm_shim_free(core::ptr::null_mut()) };
        let ptr = rust_zstd_wasm_shim_calloc(7, 9);
        assert!(!ptr.is_null());
        assert_eq!(ptr as usize % ALLOCATION_ALIGN, 0);
        unsafe {
            assert!(
                core::slice::from_raw_parts(ptr.cast::<u8>(), 63)
                    .iter()
                    .all(|b| *b == 0)
            );
            rust_zstd_wasm_shim_free(ptr);
        }
    }

    #[test]
    fn zero_length_memory_operations_accept_null() {
        unsafe {
            assert_eq!(
                rust_zstd_wasm_shim_memcmp(core::ptr::null(), core::ptr::null(), 0),
                0
            );
            assert!(
                rust_zstd_wasm_shim_memcpy(core::ptr::null_mut(), core::ptr::null(), 0).is_null()
            );
            assert!(
                rust_zstd_wasm_shim_memmove(core::ptr::null_mut(), core::ptr::null(), 0).is_null()
            );
            assert!(rust_zstd_wasm_shim_memset(core::ptr::null_mut(), 0, 0).is_null());
        }
    }
}
