from clamp import clamp
assert clamp(-1, 0, 10) == 0
assert clamp(5, 0, 10) == 5
assert clamp(11, 0, 10) == 10
assert clamp(10, 0, 10) == 10
try:
    clamp(1, 10, 0)
except ValueError:
    pass
else:
    raise AssertionError('reversed bounds must raise ValueError')
print('5 acceptance cases passed')
