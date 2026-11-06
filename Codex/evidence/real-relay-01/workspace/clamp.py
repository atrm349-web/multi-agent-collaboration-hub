def clamp(value, low, high):
    if low > high:
        raise ValueError
    return min(max(value, low), high)